use std::{
    collections::HashMap,
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Default)]
struct Requests {
    active: HashMap<String, Arc<AtomicBool>>,
    cancelled: HashMap<String, Instant>,
}

#[derive(Default)]
pub struct MediaStreamRegistry(Mutex<Requests>);

impl MediaStreamRegistry {
    pub async fn run<T>(
        &self,
        id: &str,
        work: impl Future<Output = Result<T, String>>,
    ) -> Result<Option<T>, String> {
        let flag = {
            let mut requests = self
                .0
                .lock()
                .map_err(|_| "媒体请求注册表不可用".to_string())?;
            if requests.active.contains_key(id) {
                return Err("媒体请求标识已在使用中".to_string());
            }
            requests
                .cancelled
                .retain(|_, at| at.elapsed() < Duration::from_secs(30));
            let flag = Arc::new(AtomicBool::new(requests.cancelled.remove(id).is_some()));
            requests.active.insert(id.to_string(), flag.clone());
            flag
        };
        let _registration = Registration {
            registry: self,
            id: id.to_string(),
        };
        tokio::select! {
            biased;
            _ = crate::test_runs::wait_for_cancellation(flag) => Ok(None),
            result = work => result.map(Some),
        }
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let mut requests = self
            .0
            .lock()
            .map_err(|_| "媒体请求注册表不可用".to_string())?;
        if let Some(flag) = requests.active.get(id) {
            flag.store(true, Ordering::SeqCst);
        } else {
            // IPC cancellation may arrive before its request. Keep a short, bounded tombstone.
            requests
                .cancelled
                .retain(|_, at| at.elapsed() < Duration::from_secs(30));
            if requests.cancelled.len() >= 128 {
                if let Some(oldest) = requests
                    .cancelled
                    .iter()
                    .min_by_key(|(_, at)| **at)
                    .map(|(id, _)| id.clone())
                {
                    requests.cancelled.remove(&oldest);
                }
            }
            requests.cancelled.insert(id.to_string(), Instant::now());
        }
        Ok(())
    }
}

struct Registration<'a> {
    registry: &'a MediaStreamRegistry,
    id: String,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.registry.0.lock() {
            requests.active.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_drops_a_pending_network_future() {
        let registry = Arc::new(MediaStreamRegistry::default());
        let dropped = Arc::new(AtomicBool::new(false));
        struct OnDrop(Arc<AtomicBool>);
        impl Drop for OnDrop {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let worker_registry = registry.clone();
        let worker_dropped = dropped.clone();
        let (started, ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            worker_registry
                .run("slow", async {
                    let _guard = OnDrop(worker_dropped);
                    let _ = started.send(());
                    std::future::pending::<Result<(), String>>().await
                })
                .await
        });
        ready.await.unwrap();
        registry.cancel("slow").unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .is_none());
        assert!(dropped.load(Ordering::SeqCst));
        assert!(registry.0.lock().unwrap().active.is_empty());
    }

    #[tokio::test]
    async fn cancellation_before_registration_never_starts_work() {
        let registry = MediaStreamRegistry::default();
        registry.cancel("early").unwrap();
        let outcome = registry
            .run("early", async {
                panic!("cancelled request must not run");
                #[allow(unreachable_code)]
                Ok::<_, String>(())
            })
            .await
            .unwrap();
        assert!(outcome.is_none());
        assert_eq!(
            registry
                .run("later", async { Ok::<_, String>(42) })
                .await
                .unwrap(),
            Some(42)
        );
    }

    #[test]
    fn early_cancellations_are_bounded() {
        let registry = MediaStreamRegistry::default();
        for index in 0..1000 {
            registry.cancel(&index.to_string()).unwrap();
        }
        assert_eq!(registry.0.lock().unwrap().cancelled.len(), 128);
    }
}
