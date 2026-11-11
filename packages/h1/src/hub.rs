//! In-memory per-host registry for signals, events and relations (see `wire.rs`).
//! One `Hub` per session host, owned by `control::HostShared`. No disk, no daemon:
//! when the host process ends, the hub disappears with it.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::wire::{Edge, Event, EventKind, Frame, RelationKind, Signal};

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Signal names are plain `[A-Za-z0-9._-]{1,64}` (wire contract).
pub(crate) fn valid_signal_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

struct SignalSub {
    names: Vec<String>,
    types: Vec<String>,
    tx: mpsc::Sender<Frame>,
}

struct EventSub {
    kinds: Vec<EventKind>,
    tx: mpsc::Sender<Frame>,
}

#[derive(Default)]
struct Inner {
    signal_subs: Vec<SignalSub>,
    event_subs: Vec<EventSub>,
    edges: HashSet<Edge>,
    last_event: Option<Event>,
    closed: bool,
}

pub(crate) struct Hub {
    seq: AtomicU64,
    inner: Mutex<Inner>,
}

impl Hub {
    pub(crate) fn new() -> Self {
        Self {
            seq: AtomicU64::new(1),
            inner: Mutex::new(Inner::default()),
        }
    }

    /// Per-host increasing counter, starting at 1 (shared by events and signals).
    pub(crate) fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::SeqCst)
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.inner.lock().unwrap().closed
    }

    // ---- signals ----

    pub(crate) fn add_signal_sub(
        &self,
        names: Vec<String>,
        types: Vec<String>,
        tx: mpsc::Sender<Frame>,
    ) {
        self.inner
            .lock()
            .unwrap()
            .signal_subs
            .push(SignalSub { names, types, tx });
    }

    /// Deliver to matching live listeners; dead listeners are pruned. Returns the
    /// number of listeners the signal was delivered to.
    pub(crate) fn deliver_signal(&self, signal: &Signal) -> usize {
        let mut inner = self.inner.lock().unwrap();
        let mut delivered = 0;
        inner.signal_subs.retain(|sub| {
            let matches = (sub.names.is_empty() || sub.names.iter().any(|n| n == &signal.name))
                && (sub.types.is_empty() || sub.types.iter().any(|t| t == &signal.kind));
            if !matches {
                return true;
            }
            match sub.tx.send(Frame::Signal(signal.clone())) {
                Ok(()) => {
                    delivered += 1;
                    true
                }
                Err(_) => false,
            }
        });
        delivered
    }

    // ---- events ----

    pub(crate) fn add_event_sub(&self, kinds: Vec<EventKind>, tx: mpsc::Sender<Frame>) {
        self.inner
            .lock()
            .unwrap()
            .event_subs
            .push(EventSub { kinds, tx });
    }

    /// Build an event (stamping `ts_ms`/`seq`), remember it as the replay event,
    /// and fan it out to matching subscribers. Returns the event.
    pub(crate) fn emit_event(&self, app: &str, kind: EventKind, detail: Option<Value>) -> Event {
        let event = Event {
            kind,
            app: app.to_owned(),
            ts_ms: now_ms(),
            seq: self.next_seq(),
            detail,
        };
        let mut inner = self.inner.lock().unwrap();
        inner.last_event = Some(event.clone());
        inner.event_subs.retain(|sub| {
            if !(sub.kinds.is_empty() || sub.kinds.contains(&kind)) {
                return true;
            }
            sub.tx.send(Frame::Event(event.clone())).is_ok()
        });
        event
    }

    /// The most recent event, for `event_subscribe` replay.
    pub(crate) fn last_event(&self) -> Option<Event> {
        self.inner.lock().unwrap().last_event.clone()
    }

    // ---- relations ----

    pub(crate) fn add_edge(&self, edge: Edge) -> bool {
        self.inner.lock().unwrap().edges.insert(edge)
    }

    pub(crate) fn remove_edge(&self, edge: &Edge) -> bool {
        self.inner.lock().unwrap().edges.remove(edge)
    }

    fn kind_name(kind: RelationKind) -> &'static str {
        match kind {
            RelationKind::Parent => "parent",
            RelationKind::Supervises => "supervises",
            RelationKind::DependsOn => "depends_on",
            RelationKind::PairsWith => "pairs_with",
        }
    }

    /// All known edges, in a deterministic order.
    pub(crate) fn edges(&self) -> Vec<Edge> {
        let inner = self.inner.lock().unwrap();
        let mut edges: Vec<Edge> = inner.edges.iter().cloned().collect();
        edges.sort_by(|a, b| {
            (&a.from, Self::kind_name(a.kind), &a.to, a.cascade).cmp(&(
                &b.from,
                Self::kind_name(b.kind),
                &b.to,
                b.cascade,
            ))
        });
        edges
    }

    /// Drop every edge that mentions `app`; returns the dropped edges.
    pub(crate) fn take_edges_involving(&self, app: &str) -> Vec<Edge> {
        let mut inner = self.inner.lock().unwrap();
        let taken: Vec<Edge> = inner
            .edges
            .iter()
            .filter(|e| e.from == app || e.to == app)
            .cloned()
            .collect();
        inner.edges.retain(|e| e.from != app && e.to != app);
        taken
    }

    // ---- lifecycle ----

    /// The host is going away: drop every subscriber/listener. Streaming handlers
    /// observe their channel disconnect and write the `end` frame themselves.
    pub(crate) fn close(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.closed = true;
        inner.signal_subs.clear();
        inner.event_subs.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn signal(name: &str, kind: &str) -> Signal {
        Signal {
            name: name.into(),
            kind: kind.into(),
            from: Some("a".into()),
            to: Some("b".into()),
            data: Value::Null,
            ts_ms: 0,
            seq: 0,
        }
    }

    fn edge(from: &str, kind: RelationKind, to: &str, cascade: bool) -> Edge {
        Edge {
            from: from.into(),
            kind,
            to: to.into(),
            cascade,
        }
    }

    #[test]
    fn seq_starts_at_one_and_increases() {
        let hub = Hub::new();
        assert_eq!(hub.next_seq(), 1);
        assert_eq!(hub.next_seq(), 2);
    }

    #[test]
    fn signal_names_are_validated() {
        assert!(valid_signal_name("build.done"));
        assert!(valid_signal_name("a-1_B"));
        assert!(!valid_signal_name(""));
        assert!(!valid_signal_name("has space"));
        assert!(!valid_signal_name(&"x".repeat(65)));
    }

    #[test]
    fn delivery_matches_name_and_type_filters_and_prunes_dead() {
        let hub = Hub::new();
        let (tx_all, rx_all) = mpsc::channel();
        let (tx_named, rx_named) = mpsc::channel();
        let (tx_dead, _rx_dead) = mpsc::channel();
        drop(_rx_dead);
        hub.add_signal_sub(vec![], vec![], tx_all);
        hub.add_signal_sub(vec!["build.done".into()], vec!["json".into()], tx_named);
        hub.add_signal_sub(vec![], vec![], tx_dead);
        assert_eq!(hub.deliver_signal(&signal("build.done", "json")), 2);
        assert_eq!(hub.deliver_signal(&signal("other", "text")), 1);
        assert!(matches!(rx_all.try_recv(), Ok(Frame::Signal(_))));
        assert!(matches!(rx_named.try_recv(), Ok(Frame::Signal(_))));
        assert!(rx_named.try_recv().is_err());
    }

    #[test]
    fn events_fan_out_by_kind_and_replay_is_the_last_event() {
        let hub = Hub::new();
        let (tx, rx) = mpsc::channel();
        hub.add_event_sub(vec![EventKind::Asking], tx);
        hub.emit_event("app", EventKind::Started, None);
        assert!(rx.try_recv().is_err());
        let event = hub.emit_event("app", EventKind::Asking, Some(json!({"x": 1})));
        assert_eq!(event.seq, 2);
        assert_eq!(hub.last_event().unwrap().kind, EventKind::Asking);
        assert!(matches!(rx.try_recv(), Ok(Frame::Event(e)) if e.kind == EventKind::Asking));
    }

    #[test]
    fn edges_dedup_sort_and_take_involving() {
        let hub = Hub::new();
        assert!(hub.add_edge(edge("b", RelationKind::Parent, "c", true)));
        assert!(!hub.add_edge(edge("b", RelationKind::Parent, "c", true)));
        assert!(hub.add_edge(edge("a", RelationKind::DependsOn, "b", false)));
        let edges = hub.edges();
        assert_eq!(edges[0].from, "a");
        assert_eq!(edges[1].from, "b");
        let taken = hub.take_edges_involving("b");
        assert_eq!(taken.len(), 2);
        assert!(hub.edges().is_empty());
        assert!(hub.remove_edge(&edge("x", RelationKind::Parent, "y", false)) == false);
    }

    #[test]
    fn close_drops_subscribers() {
        let hub = Hub::new();
        let (tx, rx) = mpsc::channel();
        hub.add_signal_sub(vec![], vec![], tx);
        hub.close();
        assert!(hub.is_closed());
        assert_eq!(hub.deliver_signal(&signal("x", "json")), 0);
        assert!(rx.try_recv().is_err());
    }
}
