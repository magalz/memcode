use crate::state_patch::{difference, StatePatch};
use serde_json::Value;
use tokio::sync::oneshot;

struct Receipt {
    sequence: u64,
    token: String,
    acknowledged: oneshot::Sender<()>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Acknowledgement {
    pub accepted: bool,
    pub resume_drain: bool,
}

pub struct Delivery<C> {
    pub channel: C,
    pub token: String,
    pub sequence: u64,
    pub base: Option<u64>,
    pub change: StatePatch,
    pub acknowledged: oneshot::Receiver<()>,
}

/// One pending snapshot and one delivery awaiting the current JS document.
pub struct WorkspaceMailbox<C> {
    pending: Option<Value>,
    baseline: Option<(u64, Value)>,
    connection: Option<(String, C)>,
    receipt: Option<Receipt>,
    next_sequence: u64,
    draining: bool,
}

impl<C> Default for WorkspaceMailbox<C> {
    fn default() -> Self {
        Self {
            pending: None,
            baseline: None,
            connection: None,
            receipt: None,
            next_sequence: 0,
            draining: false,
        }
    }
}

impl<C: Clone> WorkspaceMailbox<C> {
    fn start(&mut self) -> bool {
        if self.draining
            || self.receipt.is_some()
            || self.connection.is_none()
            || self.pending.is_none()
        {
            return false;
        }
        self.draining = true;
        true
    }

    pub fn push(&mut self, state: Value) -> bool {
        self.pending = Some(state);
        self.start()
    }

    pub fn connect(&mut self, channel: C, token: String) -> bool {
        if let Some(previous) = self.receipt.take() {
            // Wake the old drain loop; it will use the new document's channel.
            let _ = previous.acknowledged.send(());
        }
        // A new document cannot apply patches against an old document's state.
        // Replay the latest sent state too when no newer update is waiting.
        if let Some((_, previous)) = self.baseline.take() {
            if self.pending.is_none() {
                self.pending = Some(previous);
            }
        }
        self.connection = Some((token, channel));
        self.start()
    }

    pub fn next(&mut self) -> Option<Delivery<C>> {
        if self.receipt.is_some() {
            return None;
        }
        let Some((token, channel)) = self.connection.as_ref() else {
            self.draining = false;
            return None;
        };
        let Some(state) = self.pending.take() else {
            self.draining = false;
            return None;
        };
        let token = token.clone();
        let channel = channel.clone();
        let base = self.baseline.as_ref().map(|(sequence, _)| *sequence);
        let change = match self.baseline.as_ref() {
            Some((_, previous)) => match difference(previous, &state) {
                Some(change) => change,
                None => {
                    self.draining = false;
                    return None;
                }
            },
            None => StatePatch::Replace {
                value: state.clone(),
            },
        };
        self.next_sequence = self.next_sequence.wrapping_add(1).max(1);
        let sequence = self.next_sequence;
        self.baseline = Some((sequence, state));
        let (acknowledged, receiver) = oneshot::channel();
        self.receipt = Some(Receipt {
            sequence,
            token: token.clone(),
            acknowledged,
        });
        Some(Delivery {
            channel,
            token,
            sequence,
            base,
            change,
            acknowledged: receiver,
        })
    }

    pub fn acknowledge(&mut self, sequence: u64, token: &str) -> Acknowledgement {
        let matched = self
            .receipt
            .as_ref()
            .is_some_and(|receipt| receipt.sequence == sequence && receipt.token == token);
        if !matched {
            return Acknowledgement {
                accepted: false,
                resume_drain: false,
            };
        }
        let _ = self.receipt.take().unwrap().acknowledged.send(());
        // An ordinary ACK wakes the existing drain loop. After its timeout,
        // the loop has exited: restart it here instead of requiring a second
        // JS/native connection roundtrip over the delayed transport.
        Acknowledgement {
            accepted: true,
            resume_drain: self.start(),
        }
    }

    pub fn expire(&mut self, sequence: u64, token: &str) -> bool {
        let matched = self
            .receipt
            .as_ref()
            .is_some_and(|receipt| receipt.sequence == sequence && receipt.token == token);
        if !matched {
            return false;
        }
        // Retain exactly one in-flight receipt and its channel. New snapshots
        // replace `pending`, but cannot start another delivery until this
        // document acknowledges or a new document replaces the connection.
        self.draining = false;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn workspace_waits_for_document_and_keeps_only_latest_while_unacknowledged() {
        let mut queue = WorkspaceMailbox::<()>::default();
        assert!(!queue.push(json!(0)));
        assert!(queue.connect((), "document-a".into()));
        let first = queue.next().unwrap();
        for value in 1..10_000 {
            assert!(!queue.push(json!(value)));
        }
        assert!(queue.next().is_none());
        assert!(!queue.acknowledge(first.sequence + 1, "document-a").accepted);
        assert!(!queue.acknowledge(first.sequence, "document-b").accepted);
        assert_eq!(
            queue.acknowledge(first.sequence, "document-a"),
            Acknowledgement {
                accepted: true,
                resume_drain: false
            }
        );
        assert_eq!(
            queue.next().unwrap().change,
            StatePatch::Replace {
                value: json!(9_999)
            }
        );
    }

    #[test]
    fn reload_retires_old_receipt_and_stale_ack_cannot_release_new_delivery() {
        let mut queue = WorkspaceMailbox::<()>::default();
        queue.connect((), "old".into());
        queue.push(json!("old snapshot"));
        let old = queue.next().unwrap();
        queue.push(json!("new snapshot"));
        assert!(!queue.connect((), "new".into()));
        let current = queue.next().unwrap();
        assert_eq!(
            current.change,
            StatePatch::Replace {
                value: json!("new snapshot")
            }
        );
        assert_eq!(current.base, None);
        assert!(!queue.acknowledge(old.sequence, "old").accepted);
        assert!(!queue.expire(old.sequence, "old"));
        assert!(queue.acknowledge(current.sequence, "new").accepted);
    }

    #[test]
    fn timed_out_consumer_pauses_until_ready_without_replaying_a_snapshot_flood() {
        let mut queue = WorkspaceMailbox::<()>::default();
        queue.connect((), "stalled".into());
        queue.push(json!("sending"));
        let stalled = queue.next().unwrap();
        assert!(queue.expire(stalled.sequence, "stalled"));
        for value in 0..10_000 {
            assert!(!queue.push(json!(value)));
        }
        assert!(queue.next().is_none());
        assert!(queue.connect((), "recovered".into()));
        let current = queue.next().unwrap();
        assert_eq!(
            current.change,
            StatePatch::Replace {
                value: json!(9_999)
            }
        );
        assert!(queue.acknowledge(current.sequence, "recovered").accepted);
        assert!(queue.next().is_none());
    }

    #[test]
    fn reconnect_without_new_updates_replays_a_full_baseline() {
        let mut queue = WorkspaceMailbox::<()>::default();
        queue.connect((), "first".into());
        queue.push(json!({"task":"finished"}));
        let first = queue.next().unwrap();
        queue.acknowledge(first.sequence, "first");
        assert!(queue.next().is_none());
        assert!(queue.connect((), "reloaded".into()));
        let replay = queue.next().unwrap();
        assert_eq!(replay.base, None);
        assert_eq!(
            replay.change,
            StatePatch::Replace {
                value: json!({"task":"finished"})
            }
        );
    }

    #[test]
    fn late_ack_resumes_only_latest_pending_without_a_reconnect() {
        let mut queue = WorkspaceMailbox::<()>::default();
        queue.connect((), "same-document".into());
        queue.push(json!("delayed"));
        let delayed = queue.next().unwrap();
        assert!(queue.expire(delayed.sequence, "same-document"));
        drop(delayed.acknowledged);
        for value in 0..10_000 {
            assert!(!queue.push(json!(value)));
        }
        assert!(queue.next().is_none());
        assert_eq!(
            queue.acknowledge(delayed.sequence, "different-document"),
            Acknowledgement {
                accepted: false,
                resume_drain: false
            }
        );
        assert_eq!(
            queue.acknowledge(delayed.sequence, "same-document"),
            Acknowledgement {
                accepted: true,
                resume_drain: true
            }
        );
        let latest = queue.next().unwrap();
        assert_eq!(latest.base, Some(delayed.sequence));
        assert_eq!(
            latest.change,
            StatePatch::Replace {
                value: json!(9_999)
            }
        );
        assert_eq!(
            queue.acknowledge(delayed.sequence, "same-document"),
            Acknowledgement {
                accepted: false,
                resume_drain: false
            }
        );
        assert!(queue.next().is_none());
        assert!(queue.acknowledge(latest.sequence, "same-document").accepted);
    }

    #[test]
    fn late_ack_without_pending_work_allows_the_next_update_to_start() {
        let mut queue = WorkspaceMailbox::<()>::default();
        queue.connect((), "document".into());
        queue.push(json!(1));
        let delayed = queue.next().unwrap();
        assert!(queue.expire(delayed.sequence, "document"));
        assert_eq!(
            queue.acknowledge(delayed.sequence, "document"),
            Acknowledgement {
                accepted: true,
                resume_drain: false
            }
        );
        assert!(queue.push(json!(2)));
        let next = queue.next().unwrap();
        assert_eq!(next.base, Some(delayed.sequence));
        assert!(!queue.acknowledge(delayed.sequence, "document").accepted);
        assert!(queue.acknowledge(next.sequence, "document").accepted);
    }

    #[test]
    fn reload_replaces_a_paused_document_and_rejects_its_late_ack() {
        let mut queue = WorkspaceMailbox::<()>::default();
        queue.connect((), "old".into());
        queue.push(json!("old"));
        let old = queue.next().unwrap();
        assert!(queue.expire(old.sequence, "old"));
        queue.push(json!("latest"));
        assert!(queue.connect((), "new".into()));
        let current = queue.next().unwrap();
        assert_eq!(current.base, None);
        assert_eq!(
            queue.acknowledge(old.sequence, "old"),
            Acknowledgement {
                accepted: false,
                resume_drain: false
            }
        );
        assert!(!queue.expire(old.sequence, "old"));
        assert!(queue.next().is_none());
        assert!(queue.acknowledge(current.sequence, "new").accepted);
    }
}
