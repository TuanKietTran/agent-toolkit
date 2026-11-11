//! The host's control server (specs 004 and 007): per connection one JSON line in, one JSON line out.
//!
//! Operations: `send`, `screen`, `screen_ansi`, `resize` (spec 004 and attach) and, from spec 007,
//! `status`, `screen_json`, `wait` and `stop`. A client that gets "unknown operation" from an older
//! host falls back to doing the work itself with `send` and `screen`.
//!
//! Every connection has its own thread, so a `wait` that blocks for minutes never delays a `send`
//! or a `screen` from another caller.

use super::*;
use state::WaitSpec;

/// Concurrent control connections. Beyond this a caller is told to retry, which keeps a runaway
/// script from exhausting threads.
const MAX_HANDLERS: usize = 64;

/// How often a blocked `wait` looks at the screen.
const WAIT_POLL: Duration = Duration::from_millis(20);

pub(crate) struct Activity {
    pub last_output: Instant,
    pub bytes: u64,
}

pub(crate) struct HostInfo {
    pub name: Option<String>,
    pub title: Option<String>,
    pub command: Vec<String>,
    pub cwd: Option<String>,
    pub started_ms: u64,
    pub pid: u32,
}

pub(crate) struct HostShared {
    pub writer: SharedWriter,
    pub hub: Arc<crate::hub::Hub>,
    pub parser: Arc<Mutex<vt100::Parser>>,
    pub resizer: Resizer,
    pub recorder: Option<Arc<Mutex<Recorder>>>,
    pub stopped: Arc<AtomicBool>,
    pub activity: Mutex<Activity>,
    pub exit_code: Mutex<Option<i32>>,
    pub killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    pub info: HostInfo,
    pub started: Instant,
    pub handlers: AtomicUsize,
    /// Present only for labs opened with `--auto-rearm` and a name.
    pub watch: Option<InputWatch>,
}

/// Watches what is typed into a hosted program (`h1 open --auto-rearm`) and reports when a submitted
/// line is exactly the new-session command. Text that merely contains the command does not match; the
/// line buffer follows backspace and kill-line, and ignores escape sequences (arrows, bracketed paste).
pub(crate) struct InputWatch {
    new_cmd: String,
    line: Mutex<Vec<u8>>,
    busy: AtomicBool,
}

impl InputWatch {
    pub fn new(new_cmd: &str) -> Self {
        InputWatch {
            new_cmd: new_cmd.trim().to_owned(),
            line: Mutex::new(Vec::new()),
            busy: AtomicBool::new(false),
        }
    }

    /// Feeds typed bytes. True when a submitted line equals the command and no re-arm is already running.
    pub fn feed(&self, data: &[u8]) -> bool {
        let mut line = self.line.lock().unwrap();
        let mut hit = false;
        let mut i = 0;
        while i < data.len() {
            match data[i] {
                0x1b => {
                    i += 1;
                    if data.get(i) == Some(&b'[') {
                        i += 1;
                        while i < data.len() && !(0x40..=0x7e).contains(&data[i]) {
                            i += 1;
                        }
                    }
                }
                b'\r' | b'\n' => {
                    if !line.is_empty() && line.as_slice() == self.new_cmd.as_bytes() {
                        hit = true;
                    }
                    line.clear();
                }
                0x7f | 0x08 => {
                    line.pop();
                }
                0x03 | 0x15 => line.clear(),
                0x20..=0x7e | 0x80..=0xff => line.push(data[i]),
                _ => {}
            }
            i += 1;
        }
        hit && !self.busy.swap(true, Ordering::SeqCst)
    }

    pub fn done(&self) {
        self.busy.store(false, Ordering::SeqCst);
    }
}

/// Called with every chunk written into the hosted program by a person or by `h1 send`.
pub(crate) fn watch_input(shared: &Arc<HostShared>, data: &[u8]) {
    let Some(watch) = &shared.watch else { return };
    if !watch.feed(data) {
        return;
    }
    let Some(name) = shared.info.name.clone() else {
        watch.done();
        return;
    };
    let shared = shared.clone();
    std::thread::spawn(move || {
        let _ = crate::commands::auto_rearm(&name);
        if let Some(watch) = &shared.watch {
            watch.done();
        }
    });
}

impl HostShared {
    /// Called for every chunk the hosted program writes.
    pub fn note_output(&self, bytes: usize) {
        let mut activity = self.activity.lock().unwrap();
        activity.last_output = Instant::now();
        activity.bytes += bytes as u64;
    }

    pub(crate) fn quiet_ms(&self) -> u64 {
        self.activity
            .lock()
            .unwrap()
            .last_output
            .elapsed()
            .as_millis() as u64
    }

    fn exit_code(&self) -> Option<i32> {
        *self.exit_code.lock().unwrap()
    }
}

fn ok() -> Value {
    json!({ "ok": true })
}

fn failure(message: impl Into<String>) -> Value {
    json!({ "ok": false, "error": message.into() })
}

pub(crate) fn serve_socket(listener: ipc::Listener, shared: Arc<HostShared>) {
    while !shared.stopped.load(Ordering::Acquire) {
        match ipc::accept(&listener) {
            Ok(stream) => {
                if shared.handlers.fetch_add(1, Ordering::AcqRel) >= MAX_HANDLERS {
                    shared.handlers.fetch_sub(1, Ordering::AcqRel);
                    let _ = reply(&stream, &failure("too many control connections; retry"));
                    continue;
                }
                let shared = shared.clone();
                thread::spawn(move || {
                    let _ = handle_control(stream, &shared);
                    shared.handlers.fetch_sub(1, Ordering::AcqRel);
                });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break,
        }
    }
}

fn reply(stream: &ipc::Stream, value: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    let mut stream = stream;
    stream.write_all(&bytes)?;
    stream.flush()?;
    Ok(())
}

fn handle_control(stream: ipc::Stream, shared: &Arc<HostShared>) -> Result<()> {
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line)?;
    let value: Value = match serde_json::from_str(&line) {
        Ok(value) => value,
        Err(error) => return reply(&stream, &failure(format!("invalid request: {error}"))),
    };
    let op = value
        .get("op")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    // Wire ops (signals/events/relations) are tried through `wire::Request` before
    // `dispatch` answers "unknown operation" (see the wire contract header).
    if matches!(
        op.as_str(),
        "signal_emit"
            | "signal_listen"
            | "event_subscribe"
            | "relation_add"
            | "relation_remove"
            | "relation_list"
            | "relation_release"
    ) {
        let request: crate::wire::Request = match serde_json::from_value(value) {
            Ok(request) => request,
            Err(error) => {
                return reply(&stream, &failure(format!("invalid request: {error}")));
            }
        };
        return handle_wire(stream, shared, request);
    }
    reply(&stream, &dispatch(&value, shared))
}

pub(crate) fn response_value(response: crate::wire::Response) -> Value {
    serde_json::to_value(response)
        .unwrap_or_else(|_| json!({ "ok": false, "error": "failed to serialize response" }))
}

fn write_frame(stream: &ipc::Stream, frame: &crate::wire::Frame) -> Result<()> {
    let mut bytes = serde_json::to_vec(frame)?;
    bytes.push(b'\n');
    let mut stream = stream;
    stream.write_all(&bytes)?;
    stream.flush()?;
    Ok(())
}

fn handle_wire(
    stream: ipc::Stream,
    shared: &Arc<HostShared>,
    request: crate::wire::Request,
) -> Result<()> {
    use crate::wire::{Frame, Request, Response};
    match request {
        Request::SignalEmit { signal } => {
            if !crate::hub::valid_signal_name(&signal.name) {
                return reply(
                    &stream,
                    &response_value(Response::Plain {
                        ok: false,
                        error: Some(format!("invalid signal name: {}", signal.name)),
                    }),
                );
            }
            let mut signal = signal;
            // The receiving host stamps the envelope: target, time and per-host seq.
            signal.to = shared.info.name.clone();
            signal.ts_ms = crate::hub::now_ms();
            signal.seq = shared.hub.next_seq();
            let delivered = shared.hub.deliver_signal(&signal);
            reply(
                &stream,
                &response_value(Response::Delivered {
                    ok: true,
                    delivered,
                }),
            )
        }
        Request::SignalListen { names, types } => handle_stream(
            stream,
            shared,
            move |hub, tx| hub.add_signal_sub(names, types, tx),
            None,
        ),
        Request::EventSubscribe { kinds, replay } => {
            let replay_frame = if replay {
                shared
                    .hub
                    .last_event()
                    .filter(|event| kinds.is_empty() || kinds.contains(&event.kind))
                    .map(Frame::Event)
            } else {
                None
            };
            handle_stream(
                stream,
                shared,
                move |hub, tx| hub.add_event_sub(kinds, tx),
                replay_frame,
            )
        }
        other => reply(&stream, &crate::observe::relation_op(shared, other)),
    }
}

/// Serve one streaming subscription: register the caller's sender with the hub,
/// answer `{"ok":true,"stream":true}`, then write one `Frame` per line until the
/// client disconnects or the host goes away (then a final `end` frame).
fn handle_stream(
    stream: ipc::Stream,
    shared: &Arc<HostShared>,
    register: impl FnOnce(&crate::hub::Hub, mpsc::Sender<crate::wire::Frame>),
    replay: Option<crate::wire::Frame>,
) -> Result<()> {
    let (tx, rx) = mpsc::channel();
    register(&shared.hub, tx);
    reply(&stream, &json!({ "ok": true, "stream": true }))?;
    if let Some(frame) = &replay {
        write_frame(&stream, frame)?;
    }
    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(frame) => {
                if write_frame(&stream, &frame).is_err() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if shared.stopped.load(Ordering::Acquire) || shared.hub.is_closed() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let _ = write_frame(&stream, &crate::wire::Frame::End);
    Ok(())
}

fn dispatch(request: &Value, shared: &Arc<HostShared>) -> Value {
    let op = request
        .get("op")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match op {
        "send" => op_send(request, shared),
        "screen" => {
            let text = shared.parser.lock().unwrap().screen().contents();
            json!({ "ok": true, "screen": text })
        }
        "screen_ansi" => op_screen_ansi(shared),
        "screen_json" => op_screen_json(request, shared),
        "resize" => op_resize(request, shared),
        "status" => op_status(shared),
        "wait" => op_wait(request, shared),
        "stop" => op_stop(shared),
        other => failure(format!("unknown operation: {other}")),
    }
}

fn op_send(request: &Value, shared: &Arc<HostShared>) -> Value {
    let data: Vec<u8> = match request.get("data").cloned().map(serde_json::from_value) {
        Some(Ok(data)) => data,
        Some(Err(error)) => return failure(format!("invalid request: {error}")),
        None => Vec::new(),
    };
    let result = (|| -> Result<()> {
        let mut output = shared.writer.lock().unwrap();
        output.write_all(&data)?;
        output.flush()?;
        if let Some(recorder) = &shared.recorder {
            recorder.lock().unwrap().chunk("input", &data)?;
        }
        Ok(())
    })();
    if result.is_ok() && request.get("watch").and_then(Value::as_bool) != Some(false) {
        watch_input(shared, &data);
    }
    match result {
        Ok(()) => ok(),
        Err(error) => failure(error.to_string()),
    }
}

fn op_screen_ansi(shared: &HostShared) -> Value {
    let parser = shared.parser.lock().unwrap();
    let screen = parser.screen();
    let mut bytes = screen.contents_formatted();
    let (row, col) = screen.cursor_position();
    bytes.extend(format!("\x1b[{};{}H", row + 1, col + 1).bytes());
    bytes.extend(if screen.hide_cursor() {
        &b"\x1b[?25l"[..]
    } else {
        &b"\x1b[?25h"[..]
    });
    json!({ "ok": true, "screen": String::from_utf8_lossy(&bytes).into_owned() })
}

fn op_resize(request: &Value, shared: &HostShared) -> Value {
    let rows = request.get("rows").and_then(Value::as_u64).unwrap_or(0) as u16;
    let cols = request.get("cols").and_then(Value::as_u64).unwrap_or(0) as u16;
    if rows == 0 || cols == 0 {
        return failure("resize needs rows and cols greater than zero");
    }
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let result = match shared.resizer.upgrade() {
        Some(master) => master
            .lock()
            .unwrap()
            .resize(size)
            .map_err(|error| error.to_string()),
        None => Err("the child has exited".to_string()),
    };
    match result {
        Ok(()) => {
            shared.parser.lock().unwrap().set_size(rows, cols);
            ok()
        }
        Err(error) => failure(error),
    }
}

fn color(color: vt100::Color) -> Value {
    match color {
        vt100::Color::Default => json!("default"),
        vt100::Color::Idx(index) => json!(index),
        vt100::Color::Rgb(red, green, blue) => json!(format!("#{red:02x}{green:02x}{blue:02x}")),
    }
}

/// Runs of cells that are not in the default style, per row. The text of a run is what is shown
/// there, so a caller can find, for example, the grey suggestion after a prompt.
fn styled_runs(screen: &vt100::Screen) -> Vec<Value> {
    type Style = (vt100::Color, vt100::Color, bool, bool, bool, bool);
    let (rows, cols) = screen.size();
    let mut runs = Vec::new();
    for row in 0..rows {
        let mut current: Option<(u16, Style, String)> = None;
        let mut flush = |run: Option<(u16, Style, String)>, end: u16| {
            if let Some((start, style, text)) = run
                && !text.trim().is_empty()
            {
                runs.push(json!({
                    "row": row, "col": start, "len": end - start, "text": text,
                    "fg": color(style.0), "bg": color(style.1),
                    "bold": style.2, "italic": style.3, "underline": style.4, "inverse": style.5,
                }));
            }
        };
        for col in 0..cols {
            let Some(cell) = screen.cell(row, col) else {
                continue;
            };
            if cell.is_wide_continuation() {
                continue;
            }
            let style: Style = (
                cell.fgcolor(),
                cell.bgcolor(),
                cell.bold(),
                cell.italic(),
                cell.underline(),
                cell.inverse(),
            );
            let plain = style
                == (
                    vt100::Color::Default,
                    vt100::Color::Default,
                    false,
                    false,
                    false,
                    false,
                );
            let text = if cell.has_contents() {
                cell.contents()
            } else {
                " ".to_string()
            };
            match &mut current {
                Some((_, run_style, run_text)) if !plain && *run_style == style => {
                    run_text.push_str(&text)
                }
                _ => {
                    flush(current.take(), col);
                    if !plain {
                        current = Some((col, style, text));
                    }
                }
            }
        }
        flush(current.take(), cols);
    }
    runs
}

fn op_screen_json(request: &Value, shared: &HostShared) -> Value {
    let parser = shared.parser.lock().unwrap();
    let screen = parser.screen();
    let (rows, cols) = screen.size();
    let (cursor_row, cursor_col) = screen.cursor_position();
    let lines: Vec<String> = screen.rows(0, cols).collect();
    let mut value = json!({
        "ok": true, "rows": rows, "cols": cols, "cursor": [cursor_row, cursor_col],
        "hide_cursor": screen.hide_cursor(), "application_cursor": screen.application_cursor(),
        "alternate_screen": screen.alternate_screen(), "title": screen.title(), "lines": lines,
    });
    if request
        .get("spans")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        value["spans"] = Value::Array(styled_runs(screen));
    }
    value
}

fn op_status(shared: &HostShared) -> Value {
    let (rows, cols, cursor, hide, application, title) = {
        let parser = shared.parser.lock().unwrap();
        let screen = parser.screen();
        let (rows, cols) = screen.size();
        let (row, col) = screen.cursor_position();
        (
            rows,
            cols,
            [row, col],
            screen.hide_cursor(),
            screen.application_cursor(),
            screen.title().to_owned(),
        )
    };
    let (quiet_ms, bytes) = {
        let activity = shared.activity.lock().unwrap();
        (
            activity.last_output.elapsed().as_millis() as u64,
            activity.bytes,
        )
    };
    let exit_code = shared.exit_code();
    json!({
        "ok": true, "version": env!("CARGO_PKG_VERSION"), "pid": shared.info.pid, "name": shared.info.name,
        "title": shared.info.title, "command": shared.info.command, "cwd": shared.info.cwd,
        "started_ms": shared.info.started_ms, "uptime_ms": shared.started.elapsed().as_millis() as u64,
        "rows": rows, "cols": cols, "cursor": cursor, "hide_cursor": hide, "application_cursor": application,
        "window_title": title, "quiet_ms": quiet_ms, "bytes_out": bytes,
        "running": exit_code.is_none(), "exit_code": exit_code,
    })
}

/// Blocks until the conditions of `spec` hold, the program exits, or `timeout_ms` passes.
/// `min_wait_ms` keeps a wait from ending before the program has had time to react to input that was
/// sent just before it (`ask` uses it so that an old quiet screen does not count as the answer).
fn op_wait(request: &Value, shared: &HostShared) -> Value {
    let spec: WaitSpec = match request.get("spec").cloned().map(serde_json::from_value) {
        Some(Ok(spec)) => spec,
        Some(Err(error)) => return failure(format!("invalid wait: {error}")),
        None => WaitSpec::default(),
    };
    let compiled = match spec.compile() {
        Ok(compiled) => compiled,
        Err(error) => return failure(format!("{error:#}")),
    };
    let timeout = Duration::from_millis(
        request
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(120_000),
    );
    let min_wait = Duration::from_millis(
        request
            .get("min_wait_ms")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    );
    let begun = Instant::now();
    loop {
        let screen = shared.parser.lock().unwrap().screen().contents();
        let elapsed = begun.elapsed();
        if elapsed >= min_wait && compiled.met(&screen, shared.quiet_ms()) {
            return json!({ "ok": true, "met": true, "screen": screen });
        }
        if let Some(code) = shared.exit_code() {
            return json!({ "ok": true, "met": false, "exited": true, "exit_code": code, "screen": screen });
        }
        if elapsed >= timeout {
            return json!({ "ok": true, "met": false, "timed_out": true, "screen": screen });
        }
        thread::sleep(WAIT_POLL);
    }
}

fn op_stop(shared: &HostShared) -> Value {
    // The host ends when its program does; killing the program is all that is needed.
    match shared.killer.lock().unwrap().kill() {
        Ok(()) => ok(),
        // Already gone is what the caller wanted.
        Err(_) if shared.exit_code().is_some() => ok(),
        Err(error) => failure(format!("failed to stop the program: {error}")),
    }
}
