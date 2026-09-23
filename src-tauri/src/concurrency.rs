// main.ts의 두 동시성 primitive(leadOperationQueues/queueLeadOperation, buildSessionRowsChain)를
// Rust/Tauri로 옮긴 것 — TAURI_NOTICE_QUEUE_DESIGN.md §2 서브청크 α, §3 참고.
//
// Node.js는 단일 스레드 이벤트 루프라서 "await 없는 동기 블록 사이에는 절대 다른 코드가 안 끼어든다"는
// 전제가 공짜로 성립하고, main.ts의 두 primitive는 그 전제 위에서 Promise 체이닝만으로 구현돼 있다.
// Tauri는 멀티스레드 tokio 런타임 위에서 IPC 커맨드를 각각 독립된 태스크로 돌리므로(진짜 병렬 실행),
// 이 파일이 그 안전성을 명시적으로 다시 만든다.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex as StdMutex, OnceLock};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

type Job = Pin<Box<dyn Future<Output = ()> + Send>>;

struct LeadQueue {
    tx: mpsc::UnboundedSender<Job>,
}

fn lead_queues() -> &'static StdMutex<HashMap<String, LeadQueue>> {
    static QUEUES: OnceLock<StdMutex<HashMap<String, LeadQueue>>> = OnceLock::new();
    QUEUES.get_or_init(|| StdMutex::new(HashMap::new()))
}

// internalId 하나당 경량 액터(mpsc 채널 + 그 채널만 읽는 태스크) 하나 — §3-2가 추천한 방식을 그대로
// 따른다. HashMap<String, tokio::sync::Mutex<()>>(락 기반) 대신 이 방식을 고른 이유:
// 1) Node의 `.then(fn, fn)` + `run.then(()=>undefined, ()=>undefined)`는 "이전 작업이 성공했든
//    실패했든(reject) 다음 작업은 반드시 실행된다"는 뜻이다. 락 기반으로 옮기면 "이전 작업의 Future가
//    panic했을 때 Mutex가 poisoned 상태가 되어 이후 lock()이 전부 Err를 반환"하는 Rust 특유의 문제를
//    별도로 처리해야 한다(§3-2에 명시된 우려) — 액터 방식은 각 작업을 개별 tokio::spawn으로 격리해서
//    이 문제 자체가 생기지 않는다(아래 참고).
// 2) 액터가 처리하는 job 자체를 tokio::spawn으로 한 번 더 감싸서 실행한다 — job 내부에서 panic이 나도
//    그 panic은 spawn된 하위 태스크 안에서 잡히고(JoinHandle::await가 Err를 반환), 액터의 while 루프
//    (=그 internalId의 향후 모든 작업을 처리할 유일한 통로) 자체는 절대 죽지 않는다. 만약 액터 루프가
//    job을 직접 await했다면 job의 panic이 액터 태스크 자체를 unwind시켜 죽이고, 그 internalId로 큐잉된
//    이후 모든 작업이 영구히(그 태스크가 다시 안 살아나므로) 응답 없이 멈춘다 — Node에는 없던 새로운
//    사고 클래스라 반드시 막아야 한다.
//
// internalId별 액터는 한 번 만들어지면 앱이 죽을 때까지 계속 살아있다(Map에서 절대 안 지움) — 이것도
// Node 원본과 동일하다(leadOperationQueues 역시 키를 절대 delete하지 않는다). 유휴 액터 하나가 mpsc
// 채널의 recv().await로 잠들어 있는 비용은 무시할 수 있는 수준이고, 팀장 수는 앱 수명 동안 적은 수로
// 유지되므로 이 방식이 간단함과 충실도(fidelity) 양쪽에서 더 낫다.
fn spawn_lead_actor() -> mpsc::UnboundedSender<Job> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Job>();
    tokio::spawn(async move {
        while let Some(job) = rx.recv().await {
            let handle = tokio::spawn(job);
            let _ = handle.await; // panic 여부와 무관하게 다음 job으로 진행 — 위 주석 참고.
        }
    });
    tx
}

/// leadOperationQueues/queueLeadOperation(main.ts:1861-1868)의 포팅.
///
/// 같은 internalId로 큐잉된 작업들은 반드시 큐잉된 순서대로, 하나가 끝나야 다음이 시작되도록
/// 직렬화된다(포크·메시지 엇갈림을 막는 이 코드베이스 전체의 핵심 방어 — A~E군 대부분이 이 위에서
/// 성립한다). 서로 다른 internalId는 완전히 독립적으로 동시 진행된다(Node 원본도 internalId별로
/// 별개의 Promise 체인이라 마찬가지).
///
/// 서브청크 β(resume.rs)가 resume_lead_command에서 이 함수의 첫 실제 호출부를 추가했다 — α가
/// 남겨둔 #[allow(dead_code)]는 그래서 여기서 뗀다.
pub async fn queue_lead_operation<T, F, Fut>(internal_id: &str, f: F) -> T
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let tx = {
        let mut guard = lead_queues().lock().unwrap();
        guard
            .entry(internal_id.to_string())
            .or_insert_with(|| LeadQueue { tx: spawn_lead_actor() })
            .tx
            .clone()
    };

    let (result_tx, result_rx) = oneshot::channel::<T>();
    let job: Job = Box::pin(async move {
        let result = f().await;
        let _ = result_tx.send(result);
    });

    // 액터는 앱 수명 동안 절대 종료되지 않으므로(위 주석) 이 send는 항상 성공해야 정상이다.
    tx.send(job).expect("lead operation actor channel closed unexpectedly");
    result_rx
        .await
        .expect("lead operation panicked before producing a result")
}

/// buildSessionRowsChain(main.ts:1535-1540)의 포팅 — "작업 탭 보드 rows를 만드는 호출은 항상
/// 시작 순서대로 완료된다"는 전역 직렬화. internalId별이 아니라 앱 전체에 단 하나뿐이라는 점이
/// queue_lead_operation과 다르다(다른 팀장을 향한 작업끼리는 동시에 진행돼도 되지만, rows 계산은
/// 그 자체로 "지금 이 순간의 전체 스냅숏"이라 여러 개가 겹치면 완료 순서가 뒤집힐 때 화면이 오래된
/// 값으로 덮어써질 수 있다 — C-2 참고).
///
/// §3-3 트레이드오프 결정: "완료 순서 = 시작 순서" 지연 특성까지 Node와 동일하게 유지한다(예: 새로고침
/// 버튼을 눌러도 진행 중인 3초 폴링이 끝날 때까지 기다림). "최신 요청만 유효하고 나머지는 취소"하는
/// 방식으로 바꾸는 개선은 의도적으로 이번 청크에서 하지 않았다 — 그 변경은 C-2 방어가 실제로 막으려던
/// "오래된 스냅숏이 최신 상태를 덮어쓴다"는 문제와 별개로 "사용자가 새로고침을 눌렀는데 그 요청 자체가
/// 조용히 취소된다"는 새로운 사용자 경험 질문을 만들기 때문에, 이 청크(동시성 primitive 이관)의
/// 범위를 넘어선다고 판단했다. 필요해지면 이 락을 취소 가능한 구조(예: 매 호출에 토큰을 발급하고
/// "가장 최신 토큰만 결과를 렌더러에 반영") 로 바꾸는 건 δ 이후 별도로 다룰 문제로 남겨둔다.
pub fn session_rows_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::Mutex as TokioStdMutex;
    use tokio::time::sleep;

    // "같은 키로 동시에 두 작업을 큐잉하면 순서대로 실행되는지" — 설계 문서 §2가 요구한 검증 그대로.
    // job1이 먼저 큐잉되고 더 오래 걸리도록(sleep) 만든 뒤, job1의 시작~종료 구간 밖에서 job2가 절대
    // 시작하지 않아야 한다(=job1이 끝나야 job2가 시작).
    #[tokio::test]
    async fn queued_operations_on_same_key_run_strictly_in_order() {
        let log: Arc<TokioStdMutex<Vec<&'static str>>> = Arc::new(TokioStdMutex::new(Vec::new()));

        let log1 = log.clone();
        let first = tokio::spawn(queue_lead_operation("lead-a", move || async move {
            log1.lock().await.push("job1-start");
            sleep(Duration::from_millis(60)).await;
            log1.lock().await.push("job1-end");
            1
        }));

        // job1이 확실히 먼저 큐에 들어가도록 아주 짧게 양보한다.
        sleep(Duration::from_millis(10)).await;

        let log2 = log.clone();
        let second = tokio::spawn(queue_lead_operation("lead-a", move || async move {
            log2.lock().await.push("job2-start");
            sleep(Duration::from_millis(10)).await;
            log2.lock().await.push("job2-end");
            2
        }));

        let (r1, r2): (i32, i32) = (first.await.unwrap(), second.await.unwrap());
        assert_eq!(r1, 1);
        assert_eq!(r2, 2);

        let entries = log.lock().await.clone();
        assert_eq!(
            entries,
            vec!["job1-start", "job1-end", "job2-start", "job2-end"],
            "같은 키의 작업은 반드시 시작한 순서대로 끝나고 나서 다음이 시작해야 한다"
        );
    }

    // "먼저 들어온 작업이 실패(panic)해도 다음 작업은 계속 진행하는지" — Node의
    // `.then(fn, fn)`이 이전 작업의 성공/실패와 무관하게 다음 작업을 실행한다는 의미를 그대로
    // 검증한다(설계 문서 §3-2가 "이전 작업이 실패해도 다음 작업은 계속 진행"이라고 명시한 부분).
    #[tokio::test]
    async fn a_panicking_operation_does_not_block_the_next_one_on_the_same_key() {
        let key = "lead-panic-test";

        let first = tokio::spawn(async move {
            queue_lead_operation(key, || async move {
                panic!("의도적인 테스트 panic — job1이 실패해도 job2는 진행돼야 한다");
                #[allow(unreachable_code)]
                1
            })
            .await
        });
        // job1의 panic이 실제로 일어나고 액터가 그 결과를 처리할 시간을 준다.
        let first_outcome = first.await; // JoinHandle 자체가 Err(panic)를 돌려준다.
        assert!(first_outcome.is_err(), "job1은 panic으로 실패해야 한다");

        // job2는 같은 키로도 정상적으로 실행돼야 한다 — 액터가 죽지 않았다는 증거.
        let second = queue_lead_operation(key, || async move { 42 }).await;
        assert_eq!(second, 42, "이전 작업이 panic해도 같은 키의 다음 작업은 정상 실행돼야 한다");
    }

    // 서로 다른 키는 서로를 기다리지 않고 독립적으로 진행돼야 한다(Node 원본도 internalId별로
    // 완전히 다른 Promise 체인이라 마찬가지).
    #[tokio::test]
    async fn different_keys_do_not_block_each_other() {
        let log: Arc<TokioStdMutex<Vec<&'static str>>> = Arc::new(TokioStdMutex::new(Vec::new()));

        let log_a = log.clone();
        let a = tokio::spawn(queue_lead_operation("lead-x", move || async move {
            log_a.lock().await.push("x-start");
            sleep(Duration::from_millis(50)).await;
            log_a.lock().await.push("x-end");
        }));

        sleep(Duration::from_millis(5)).await;

        let log_b = log.clone();
        let b = tokio::spawn(queue_lead_operation("lead-y", move || async move {
            log_b.lock().await.push("y-start");
            log_b.lock().await.push("y-end");
        }));

        let _ = tokio::join!(a, b);

        let entries = log.lock().await.clone();
        // lead-y는 lead-x의 sleep(50ms)을 기다리지 않고 훨씬 먼저 끝나야 한다 — 즉 y-end가
        // x-end보다 로그 상 먼저 나와야 한다(서로 다른 키가 서로를 막지 않는다는 증거).
        let y_end_pos = entries.iter().position(|e| *e == "y-end").unwrap();
        let x_end_pos = entries.iter().position(|e| *e == "x-end").unwrap();
        assert!(y_end_pos < x_end_pos, "서로 다른 키는 서로를 기다리면 안 된다: {entries:?}");
    }

    // "먼저 들어온 buildSessionRows 호출이 끝나야 다음이 시작하는지" — session_rows_lock 자체의
    // 직렬화를 인위적 경합으로 검증한다(E-2의 "이론이 아니라 검증됨" 정신).
    #[tokio::test]
    async fn session_rows_lock_serializes_overlapping_calls() {
        // 이 락은 전역 static이라 다른 테스트와 동시에 돌면 서로 간섭할 수 있으므로, 이 테스트
        // 안에서 락을 실제로 획득해 순서를 검증하되 결과 집합만 확인한다(다른 테스트가 이 락을
        // 안 쓰므로 실제로는 간섭이 없다 — 이 crate에서 session_rows_lock을 쓰는 테스트는
        // 이것 하나뿐이다).
        let log: Arc<TokioStdMutex<Vec<&'static str>>> = Arc::new(TokioStdMutex::new(Vec::new()));

        let log1 = log.clone();
        let first = tokio::spawn(async move {
            let _guard = session_rows_lock().lock().await;
            log1.lock().await.push("call1-start");
            sleep(Duration::from_millis(60)).await;
            log1.lock().await.push("call1-end");
        });

        sleep(Duration::from_millis(10)).await;

        let log2 = log.clone();
        let second = tokio::spawn(async move {
            let _guard = session_rows_lock().lock().await;
            log2.lock().await.push("call2-start");
            log2.lock().await.push("call2-end");
        });

        let _ = tokio::join!(first, second);

        let entries = log.lock().await.clone();
        assert_eq!(
            entries,
            vec!["call1-start", "call1-end", "call2-start", "call2-end"],
            "겹쳐 호출돼도 완료 순서가 항상 시작 순서와 같아야 한다(buildSessionRowsChain과 동치)"
        );
    }
}
