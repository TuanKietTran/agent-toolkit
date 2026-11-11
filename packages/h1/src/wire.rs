//! Wire contract for signals, events and relations (goal A). ONE shared contract: every module
//! that sends or receives these frames uses these types, nothing re-declares them.
//!
//! Transport: the existing per-session h1 socket, same framing as `control.rs`: one JSON line in
//! (a [`Request`], tagged by `op`), then either one JSON line out (a [`Response`]) or, for the
//! two streaming ops `signal_listen` and `event_subscribe`, a first line `{"ok":true,"stream":true}`
//! followed by one [`Frame`] per line until the client disconnects or the host exits (the host then
//! writes `{"frame":"end"}` and closes). Unknown ops are still answered by `control::dispatch`
//! with "unknown operation: X"; new ops are tried through `Request` before that error.
//!
//! State: all in memory in the host process. There is no central daemon. Each session host owns
//! its own listeners, subscribers and relation edges. An edge `from kind to` is stored in BOTH the
//! `from` host and the `to` host (the CLI sends `relation_add` to `from`, which mirrors it to `to`
//! with `mirror: true`). When a host ends it sends `relation_release` to each peer host over their
//! sockets, then its memory disappears with the process. Nothing is written to disk by this
//! feature: no pid, lock, spool or notes files, no polling of files.
//!
//! Commands (names fixed):
//!   h1 signal emit [-n FROM] (--to APP | --all) NAME [--type T] [--data JSON | --text TEXT]
//!   h1 signal listen -n APP [--signal N] [--type T] [--count N] [--timeout-ms MS]
//!   h1 event subscribe (-n APP... | --all) [--kind K,K] [--count N] [--timeout-ms MS]
//!   h1 relation add FROM KIND TO [--cascade]
//!   h1 relation list [-n APP] [--json]
//!   h1 relation remove FROM KIND TO
//!   h1 relation graph [--json]
//! Streams print one JSON object per line (the `Frame` for event/signal).
//! Console: `r` toggles a relations overlay on `:graph`; `:events` (key 5) is the events pane.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Kinds of state change a host observes about its own program.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    /// The host is up and the program running (emitted once to subscribers present at start, and
    /// to any later subscriber as a first replay of current state).
    Started,
    /// The screen shows a dialog waiting for a person (`state::State::Asking`).
    Asking,
    /// No output for the stalled threshold (`state::State::Stalled`).
    Stalled,
    /// Back to quiet, not asking: the program finished a turn.
    Idle,
    /// The hosted program ended (detail: `exit_code`).
    Exited,
    /// The host is closing (after `exited`, or by `stop`/`close`); last event of a session.
    Closed,
    /// A related app ended. `app` is the app that RECEIVES the event; detail has
    /// `{"ended": <name>, "relation": <RelationKind>, "role": "from"|"to"}` (role of the ended app).
    RelationEnded,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub kind: EventKind,
    /// Session the event is about (for `relation_ended`, the session that receives it).
    pub app: String,
    /// Milliseconds since the Unix epoch.
    pub ts_ms: u64,
    /// Per-host increasing counter, starting at 1.
    pub seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

/// A named, typed message one app emits and others receive.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Signal {
    /// Signal name, e.g. `build.done`. Plain `[A-Za-z0-9._-]{1,64}`.
    pub name: String,
    /// Payload type label, e.g. `text`, `json`, or any short label. Default `json`.
    #[serde(rename = "type", default = "default_type")]
    pub kind: String,
    /// Emitting session, if known (`H1_SELF` or `-n`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// Receiving session; set by the receiving host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(default)]
    pub data: Value,
    #[serde(default)]
    pub ts_ms: u64,
    #[serde(default)]
    pub seq: u64,
}

fn default_type() -> String {
    "json".to_owned()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationKind {
    /// `a parent b`: a is the parent of b.
    Parent,
    /// `a supervises b`.
    Supervises,
    /// `a depends_on b`: a needs b; when b ends, a gets `relation_ended`.
    DependsOn,
    /// `a pairs_with b`: symmetric.
    PairsWith,
}

impl RelationKind {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "parent" => Some(Self::Parent),
            "supervises" => Some(Self::Supervises),
            "depends_on" => Some(Self::DependsOn),
            "pairs_with" => Some(Self::PairsWith),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Edge {
    pub from: String,
    pub kind: RelationKind,
    pub to: String,
    /// Only meaningful for `parent`: closing/ending the parent stops the child.
    #[serde(default)]
    pub cascade: bool,
}

/// What a host sends to subscribers on streaming connections.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "frame", rename_all = "snake_case")]
pub enum Frame {
    Event(Event),
    Signal(Signal),
    /// Host is going away; the stream closes after this.
    End,
}

/// New control ops (tag `op`). Everything is one JSON line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// Deliver a signal to this host's listeners. Reply: `Response::Delivered`.
    SignalEmit { signal: Signal },
    /// Stream signals (streaming). Empty filters match all.
    SignalListen {
        #[serde(default)]
        names: Vec<String>,
        #[serde(default)]
        types: Vec<String>,
    },
    /// Stream events about this host (streaming). Empty `kinds` matches all.
    EventSubscribe {
        #[serde(default)]
        kinds: Vec<EventKind>,
        /// Replay the current state as one first event (`started`/`asking`/...).
        #[serde(default)]
        replay: bool,
    },
    /// Add an edge to this host's table. `mirror: true` means "stored for the other end; do not forward".
    RelationAdd {
        edge: Edge,
        #[serde(default)]
        mirror: bool,
    },
    RelationRemove {
        edge: Edge,
        #[serde(default)]
        mirror: bool,
    },
    /// Edges this host knows (both directions).
    RelationList,
    /// Sent by an ending host to its peers: drop every edge with `app`, raise `relation_ended`
    /// for the peers it concerns, and stop children if the edge has `cascade`.
    RelationRelease { app: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Response {
    Delivered {
        ok: bool,
        delivered: usize,
    },
    Edges {
        ok: bool,
        edges: Vec<Edge>,
    },
    Plain {
        ok: bool,
        #[serde(default)]
        error: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_tags_are_snake_case_ops() {
        let request = Request::RelationAdd {
            edge: Edge {
                from: "a".into(),
                kind: RelationKind::DependsOn,
                to: "b".into(),
                cascade: false,
            },
            mirror: false,
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["op"], "relation_add");
        assert_eq!(value["edge"]["kind"], "depends_on");
        assert_eq!(serde_json::from_value::<Request>(value).unwrap(), request);
    }

    #[test]
    fn frames_round_trip_and_signal_type_defaults_to_json() {
        let signal: Signal = serde_json::from_value(json!({"name": "build.done"})).unwrap();
        assert_eq!(signal.kind, "json");
        let frame = Frame::Event(Event {
            kind: EventKind::RelationEnded,
            app: "a".into(),
            ts_ms: 1,
            seq: 1,
            detail: Some(json!({"ended": "b"})),
        });
        let text = serde_json::to_string(&frame).unwrap();
        assert!(text.contains(r#""frame":"event""#) && text.contains(r#""kind":"relation_ended""#));
        assert_eq!(serde_json::from_str::<Frame>(&text).unwrap(), frame);
        assert_eq!(
            serde_json::to_string(&Frame::End).unwrap(),
            r#"{"frame":"end"}"#
        );
    }
}
