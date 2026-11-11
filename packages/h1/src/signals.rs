//! `h1 signal emit|listen` (wire contract: `wire.rs`).
//!
//! `emit` delivers a signal to the listeners registered in each target host;
//! `listen` registers in one host and prints each `Frame` as one JSON line.
//! All state lives in the hosts; this module only speaks the socket protocol.

use super::*;

#[derive(Debug, Args)]
pub(crate) struct SignalArgs {
    #[command(subcommand)]
    pub action: SignalAction,
}

#[derive(Debug, Subcommand)]
pub(crate) enum SignalAction {
    /// Deliver a signal to the listeners of one session (`--to`) or of every session (`--all`).
    Emit(SignalEmitArgs),
    /// Listen for signals in one session and print each frame as one JSON line.
    Listen(SignalListenArgs),
}

#[derive(Debug, Args)]
pub(crate) struct SignalEmitArgs {
    /// Emitting session name; defaults to $H1_SELF.
    #[arg(long, short = 'n', value_name = "NAME")]
    pub from: Option<String>,
    /// Receiving session name.
    #[arg(long = "to", value_name = "APP", conflicts_with = "all")]
    pub to: Option<String>,
    /// Deliver to every session in the registry.
    #[arg(long)]
    pub all: bool,
    /// Signal name, e.g. `data.ready`.
    #[arg(value_name = "NAME")]
    pub signal_name: String,
    /// Payload type label; defaults to `text` with `--text`, otherwise `json`.
    #[arg(long = "type", value_name = "T")]
    pub kind: Option<String>,
    /// Payload as a JSON value.
    #[arg(long, value_name = "JSON", conflicts_with = "text")]
    pub data: Option<String>,
    /// Payload as plain text.
    #[arg(long, value_name = "TEXT")]
    pub text: Option<String>,
}

#[derive(Debug, Args)]
pub(crate) struct SignalListenArgs {
    #[command(flatten)]
    pub connection: SocketArgs,
    /// Only signals with this name. Repeatable; left out matches all names.
    #[arg(long = "name", value_name = "N")]
    pub names: Vec<String>,
    /// Only signals with this type. Repeatable; left out matches all types.
    #[arg(long = "type", value_name = "T")]
    pub types: Vec<String>,
    /// Exit after printing this many signal frames.
    #[arg(long, value_name = "N")]
    pub count: Option<usize>,
    /// Give up after this many milliseconds (exit status 0, like a stream end).
    #[arg(long = "timeout-ms", value_name = "MS")]
    pub timeout_ms: Option<u64>,
}

pub(crate) fn run(args: SignalArgs) -> Result<i32> {
    match args.action {
        SignalAction::Emit(args) => emit(args),
        SignalAction::Listen(args) => listen(args),
    }
}

fn resolve_from(flag: Option<String>, env_value: Option<String>) -> Option<String> {
    flag.filter(|value| !value.is_empty())
        .or_else(|| env_value.filter(|value| !value.is_empty()))
}

fn resolve_payload(
    kind: Option<&str>,
    data: Option<&str>,
    text: Option<&str>,
) -> Result<(String, Value)> {
    let payload = match (data, text) {
        (Some(raw), _) => serde_json::from_str(raw).context("invalid --data: not valid JSON")?,
        (_, Some(text)) => Value::String(text.to_owned()),
        _ => Value::Null,
    };
    let kind = kind
        .map(str::to_owned)
        .unwrap_or_else(|| if text.is_some() { "text" } else { "json" }.to_owned());
    Ok((kind, payload))
}

fn emit_request(name: &str, kind: &str, from: Option<String>, data: Value) -> Result<Value> {
    let request = crate::wire::Request::SignalEmit {
        signal: crate::wire::Signal {
            name: name.to_owned(),
            kind: kind.to_owned(),
            from,
            to: None,
            data,
            ts_ms: 0,
            seq: 0,
        },
    };
    Ok(serde_json::to_value(request)?)
}

fn emit(args: SignalEmitArgs) -> Result<i32> {
    if !crate::hub::valid_signal_name(&args.signal_name) {
        return Err(anyhow!(
            "invalid signal name {:?}: use 1 to 64 letters, digits, '.', '_' or '-'",
            args.signal_name
        ));
    }
    let (kind, data) = resolve_payload(
        args.kind.as_deref(),
        args.data.as_deref(),
        args.text.as_deref(),
    )?;
    let from = resolve_from(args.from.clone(), env::var("H1_SELF").ok());
    let targets: Vec<(String, PathBuf)> = if args.all {
        let found: Vec<(String, PathBuf)> = session::entries()
            .into_iter()
            .map(|entry| {
                let socket = PathBuf::from(&entry.socket);
                (entry.name, socket)
            })
            .collect();
        if found.is_empty() {
            return Err(anyhow!("no sessions are running"));
        }
        found
    } else if let Some(to) = &args.to {
        vec![(to.clone(), session::socket_for(to)?)]
    } else {
        return Err(anyhow!("signal emit needs --to APP or --all"));
    };
    for (target, socket) in &targets {
        let response = request(
            socket,
            emit_request(&args.signal_name, &kind, from.clone(), data.clone())?,
        )?;
        let delivered = response
            .get("delivered")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        println!("{}", json!({ "to": target, "delivered": delivered }));
    }
    Ok(0)
}

fn listen(args: SignalListenArgs) -> Result<i32> {
    let socket = args.connection.path()?;
    let request = crate::wire::Request::SignalListen {
        names: args.names.clone(),
        types: args.types.clone(),
    };
    let stream = ipc::connect(&socket)
        .with_context(|| format!("failed to connect to {}", socket.display()))?;
    let mut message = serde_json::to_vec(&serde_json::to_value(request)?)?;
    message.push(b'\n');
    (&stream).write_all(&message)?;
    (&stream).flush()?;
    // Reader thread: the local-socket stream has no portable read timeout, so
    // lines arrive over a channel and the deadline is enforced here.
    let (sender, receiver) = mpsc::channel::<String>();
    thread::spawn(move || {
        let mut reader = BufReader::new(&stream);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if sender.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let deadline = args
        .timeout_ms
        .map(|ms| Instant::now() + Duration::from_millis(ms));
    let next_line =
        |receiver: &mpsc::Receiver<String>, deadline: Option<Instant>| -> Option<String> {
            match deadline {
                Some(deadline) => {
                    let remaining = deadline.checked_duration_since(Instant::now())?;
                    receiver.recv_timeout(remaining).ok()
                }
                None => receiver.recv().ok(),
            }
        };
    // First line is the stream handshake, never a frame: do not print it.
    let first = next_line(&receiver, deadline)
        .ok_or_else(|| anyhow!("host closed the stream before answering"))?;
    let handshake: Value = serde_json::from_str(first.trim()).context("invalid host response")?;
    if handshake.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = handshake
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(anyhow!("host rejected request: {message}"));
    }
    let mut printed = 0usize;
    while args.count.is_none_or(|count| printed < count) {
        let Some(line) = next_line(&receiver, deadline) else {
            break;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if serde_json::from_str::<Value>(trimmed)
            .ok()
            .and_then(|value| {
                value
                    .get("frame")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .as_deref()
            == Some("end")
        {
            break;
        }
        println!("{trimmed}");
        io::stdout().flush()?;
        printed += 1;
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_payload_defaults_to_text_type() {
        let (kind, data) = resolve_payload(None, None, Some("ready")).unwrap();
        assert_eq!(kind, "text");
        assert_eq!(data, json!("ready"));
    }

    #[test]
    fn data_payload_is_parsed_json_and_explicit_type_wins() {
        let (kind, data) = resolve_payload(Some("metric"), Some("{\"n\":1}"), None).unwrap();
        assert_eq!(kind, "metric");
        assert_eq!(data, json!({ "n": 1 }));
        assert!(resolve_payload(None, Some("{nope"), None).is_err());
        let (kind, data) = resolve_payload(None, None, None).unwrap();
        assert_eq!(kind, "json");
        assert_eq!(data, Value::Null);
    }

    #[test]
    fn emit_request_is_a_signal_emit_op() {
        let value = emit_request(
            "data.ready",
            "text",
            Some("producer".into()),
            json!("ready"),
        )
        .unwrap();
        assert_eq!(value["op"], "signal_emit");
        assert_eq!(value["signal"]["name"], "data.ready");
        assert_eq!(value["signal"]["type"], "text");
        assert_eq!(value["signal"]["from"], "producer");
        assert_eq!(value["signal"]["data"], "ready");
    }

    #[test]
    fn from_flag_beats_env_and_empty_is_unset() {
        assert_eq!(
            resolve_from(Some("a".into()), Some("b".into())),
            Some("a".into())
        );
        assert_eq!(resolve_from(None, Some("b".into())), Some("b".into()));
        assert_eq!(resolve_from(Some(String::new()), None), None);
    }
}
