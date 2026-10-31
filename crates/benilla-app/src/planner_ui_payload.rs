//! Skip an identical successful replay UI update without suppressing its input handling.

#[derive(Default)]
pub(crate) struct UiPayload {
    successful: Option<(u64, String)>,
}

impl UiPayload {
    pub(crate) fn clear(&mut self) {
        self.successful = None;
    }

    pub(crate) fn run<E>(
        &mut self,
        session: u64,
        payload: String,
        execute: impl FnOnce(&str) -> Result<(), E>,
    ) -> Result<(), E> {
        if self
            .successful
            .as_ref()
            .is_some_and(|(old_session, old)| *old_session == session && old == &payload)
        {
            return Ok(());
        }
        // A failed update may have partially changed the UI, so even an older payload must retry.
        self.clear();
        execute(&payload)?;
        self.successful = Some((session, payload));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::UiPayload;

    #[test]
    fn identical_successful_payload_runs_once_per_session() {
        let mut memo = UiPayload::default();
        let mut executions = Vec::new();
        for (session, payload) in [(1, "same"), (1, "same"), (2, "same"), (2, "same")] {
            memo.run(session, payload.into(), |code| {
                executions.push((session, code.to_owned()));
                Ok::<_, ()>(())
            })
            .unwrap();
        }
        assert_eq!(executions, [(1, "same".into()), (2, "same".into())]);
    }

    #[test]
    fn every_changed_byte_executes_and_reverting_executes_again() {
        let mut memo = UiPayload::default();
        let payloads = [
            "Update({x=1.00,cast=0.1000},true,1.00000)",
            "Update({x=1.01,cast=0.1000},true,1.00000)",
            "Update({x=1.01,cast=0.1001},true,1.00000)",
            "Update({x=1.01,cast=0.1001},false,1.00000)",
            "Update({x=1.01,cast=0.1001},false,1.00001)",
            "Update({x=1.00,cast=0.1000},true,1.00000)",
        ];
        let mut executions = Vec::new();
        for payload in payloads {
            memo.run(1, payload.into(), |code| {
                executions.push(code.to_owned());
                Ok::<_, ()>(())
            })
            .unwrap();
        }
        assert_eq!(executions, payloads);
    }

    #[test]
    fn failure_retries_identical_payload_and_invalidates_previous_success() {
        let mut memo = UiPayload::default();
        memo.run(1, "old".into(), |_| Ok::<_, &str>(())).unwrap();
        assert_eq!(
            memo.run(1, "new".into(), |_| Err("partial update")),
            Err("partial update")
        );
        let mut retried_old = false;
        memo.run(1, "old".into(), |_| {
            retried_old = true;
            Ok::<_, &str>(())
        })
        .unwrap();
        assert!(retried_old);
        assert_eq!(
            memo.run(1, "new".into(), |_| Err("failure")),
            Err("failure")
        );
        let mut retried_failed = false;
        memo.run(1, "new".into(), |_| {
            retried_failed = true;
            Ok::<_, &str>(())
        })
        .unwrap();
        assert!(retried_failed);
    }

    #[test]
    fn lost_ui_invalidates_even_the_same_session_and_payload() {
        let mut memo = UiPayload::default();
        memo.run(1, "same".into(), |_| Ok::<_, ()>(())).unwrap();
        memo.clear();
        let mut executed = false;
        memo.run(1, "same".into(), |_| {
            executed = true;
            Ok::<_, ()>(())
        })
        .unwrap();
        assert!(executed);
    }
}
