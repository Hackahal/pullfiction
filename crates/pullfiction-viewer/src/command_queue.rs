/// Keep the rejected command so its producer can report a failed request rather
/// than leaving a caller waiting for a completion that will never arrive.
pub(crate) fn enqueue<T>(queue: &mut Vec<T>, command: T) -> Result<(), T> {
    if queue.len() >= 1024 {
        return Err(command);
    }
    queue.push(command);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::enqueue;

    #[test]
    fn saturation_returns_the_rejected_request_without_losing_accepted_work() {
        let mut queue: Vec<_> = (0..1024).collect();
        let original = queue.clone();
        assert_eq!(enqueue(&mut queue, 1024), Err(1024));
        assert_eq!(queue, original);
        queue.clear();
        assert_eq!(enqueue(&mut queue, 1025), Ok(()));
        assert_eq!(queue, vec![1025]);
    }

    #[test]
    fn final_slot_is_accepted_and_next_request_remains_available_for_failure_reporting() {
        let mut queue = vec!["ordinary command"; 1023];
        assert_eq!(enqueue(&mut queue, "marker request A"), Ok(()));
        assert_eq!(
            enqueue(&mut queue, "marker request B"),
            Err("marker request B")
        );
        assert_eq!(queue.len(), 1024);
        assert_eq!(queue.last(), Some(&"marker request A"));
    }
}
