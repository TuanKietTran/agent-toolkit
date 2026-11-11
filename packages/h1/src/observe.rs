//! Host-side event source and relation handling (wire contract: `wire.rs`).
//!
//! `start` runs a thread inside the host that watches the hosted program's own screen state in
//! memory (no files) and turns changes into events. `finish` is called once when the program has
//! ended: it raises `exited`, releases the relations over the peers' sockets and raises `closed`.
//! `relation_op` answers the relation requests that arrive on the control socket.

use std::sync::mpsc;

use super::*;
use crate::control::HostShared;
use crate::state::{self, State};
use crate::wire::{Edge, EventKind, RelationKind, Request, Response};

/// Quiet this long (not asking) is `idle`; quiet this long is `stalled` (same as `h1 list`).
const IDLE_MS: u64 = 1500;
const STALLED_MS: u64 = 8000;
const TICK: Duration = Duration::from_millis(150);
/// How long a closing host waits for its peers to take the release.
const RELEASE_WAIT: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Observed {
    Working,
    Idle,
    Asking,
    Stalled,
}

fn observe(screen: &str, quiet_ms: u64) -> Observed {
    match state::classify(screen, quiet_ms, STALLED_MS) {
        State::Asking => Observed::Asking,
        State::Stalled => Observed::Stalled,
        _ if quiet_ms >= IDLE_MS => Observed::Idle,
        _ => Observed::Working,
    }
}

fn kind_of(observed: Observed) -> Option<EventKind> {
    match observed {
        Observed::Working => None,
        Observed::Idle => Some(EventKind::Idle),
        Observed::Asking => Some(EventKind::Asking),
        Observed::Stalled => Some(EventKind::Stalled),
    }
}

fn app_name(shared: &HostShared) -> String {
    shared.info.name.clone().unwrap_or_else(|| "-".to_owned())
}

pub(crate) fn start(shared: &Arc<HostShared>) {
    let shared = shared.clone();
    thread::spawn(move || {
        let app = app_name(&shared);
        shared.hub.emit_event(
            &app,
            EventKind::Started,
            Some(json!({ "pid": shared.info.pid })),
        );
        let mut current = Observed::Working;
        while !shared.stopped.load(Ordering::Acquire) && shared.exit_code.lock().unwrap().is_none()
        {
            thread::sleep(TICK);
            let screen = shared.parser.lock().unwrap().screen().contents();
            let next = observe(&screen, shared.quiet_ms());
            if next != current {
                current = next;
                if let Some(kind) = kind_of(next) {
                    shared.hub.emit_event(&app, kind, None);
                }
            }
        }
    });
}

/// The program ended with `code`: tell subscribers and release every relation.
pub(crate) fn finish(shared: &Arc<HostShared>, code: i32) {
    let app = app_name(shared);
    shared
        .hub
        .emit_event(&app, EventKind::Exited, Some(json!({ "exit_code": code })));
    let peers: Vec<String> = shared
        .hub
        .edges()
        .into_iter()
        .map(|edge| if edge.from == app { edge.to } else { edge.from })
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let (done, waiting) = mpsc::channel();
    for peer in &peers {
        let done = done.clone();
        let peer = peer.clone();
        let app = app.clone();
        thread::spawn(move || {
            if let Ok(socket) = session::socket_for(&peer) {
                let value = serde_json::to_value(Request::RelationRelease { app }).unwrap();
                let _ = request(&socket, value);
            }
            let _ = done.send(());
        });
    }
    let deadline = Instant::now() + RELEASE_WAIT;
    for _ in &peers {
        let Some(left) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        if waiting.recv_timeout(left).is_err() {
            break;
        }
    }
    shared.hub.take_edges_involving(&app);
    shared.hub.emit_event(&app, EventKind::Closed, None);
}

fn plain(error: Option<String>) -> Value {
    crate::control::response_value(Response::Plain {
        ok: error.is_none(),
        error,
    })
}

/// An edge is sent to its `from` host, which mirrors it to the `to` host with `mirror: true`.
fn check_edge(me: &str, edge: &Edge, mirror: bool) -> std::result::Result<String, String> {
    if edge.from == edge.to {
        return Err("an app cannot relate to itself".to_owned());
    }
    let (mine, peer) = if mirror {
        (&edge.to, &edge.from)
    } else {
        (&edge.from, &edge.to)
    };
    if me != mine {
        return Err(format!("edge must be sent to {mine}, this host is {me}"));
    }
    Ok(peer.clone())
}

fn send_peer(peer: &str, request_value: Request) -> Result<()> {
    let socket = session::socket_for(peer)?;
    request(&socket, serde_json::to_value(request_value)?)
        .map(|_| ())
        .with_context(|| format!("peer {peer} is not reachable"))
}

pub(crate) fn relation_op(shared: &Arc<HostShared>, request_op: Request) -> Value {
    let me = app_name(shared);
    match request_op {
        Request::RelationAdd { edge, mirror } => {
            let peer = match check_edge(&me, &edge, mirror) {
                Ok(peer) => peer,
                Err(error) => return plain(Some(error)),
            };
            let added = shared.hub.add_edge(edge.clone());
            if !mirror
                && let Err(error) = send_peer(
                    &peer,
                    Request::RelationAdd {
                        edge: edge.clone(),
                        mirror: true,
                    },
                )
            {
                if added {
                    shared.hub.remove_edge(&edge);
                }
                return plain(Some(format!("{error:#}")));
            }
            plain(None)
        }
        Request::RelationRemove { edge, mirror } => {
            let peer = match check_edge(&me, &edge, mirror) {
                Ok(peer) => peer,
                Err(error) => return plain(Some(error)),
            };
            shared.hub.remove_edge(&edge);
            if !mirror {
                // The other end may be gone already; the local edge is removed either way.
                let _ = send_peer(&peer, Request::RelationRemove { edge, mirror: true });
            }
            plain(None)
        }
        Request::RelationList => crate::control::response_value(Response::Edges {
            ok: true,
            edges: shared.hub.edges(),
        }),
        Request::RelationRelease { app } => {
            for edge in shared.hub.take_edges_involving(&app) {
                let role = if edge.from == app { "from" } else { "to" };
                shared.hub.emit_event(
                    &me,
                    EventKind::RelationEnded,
                    Some(json!({ "ended": app, "relation": edge.kind, "role": role })),
                );
                // A parent ended: a child with a cascade edge ends with it.
                if edge.kind == RelationKind::Parent && edge.cascade && edge.from == app {
                    let _ = shared.killer.lock().unwrap().kill();
                }
            }
            plain(None)
        }
        _ => plain(Some("not a relation operation".to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_screens_become_idle_then_stalled() {
        assert_eq!(observe("$ ", 100), Observed::Working);
        assert_eq!(observe("$ ", 2_000), Observed::Idle);
        assert_eq!(observe("$ ", 9_000), Observed::Stalled);
        assert_eq!(kind_of(Observed::Working), None);
        assert_eq!(kind_of(Observed::Idle), Some(EventKind::Idle));
    }

    #[test]
    fn dialogs_are_asking() {
        assert_eq!(observe("Proceed? (y/n)", 1_000), Observed::Asking);
    }

    #[test]
    fn edges_go_to_the_from_host_and_never_to_self() {
        let edge = |from: &str, to: &str| Edge {
            from: from.into(),
            kind: RelationKind::DependsOn,
            to: to.into(),
            cascade: false,
        };
        assert_eq!(check_edge("a", &edge("a", "b"), false), Ok("b".to_owned()));
        assert_eq!(check_edge("b", &edge("a", "b"), true), Ok("a".to_owned()));
        assert!(check_edge("b", &edge("a", "b"), false).is_err());
        assert!(check_edge("a", &edge("a", "a"), false).is_err());
    }
}
