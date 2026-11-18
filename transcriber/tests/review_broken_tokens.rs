//! Review test (track transcriber-review): a model folder whose tokens.txt was cut short (an
//! interrupted first-run download; the blank token `<blk>` is the file's last line). The
//! protocol requires one `error` line (model_load_failed or model_missing) and exit code 1.
//! sherpa-onnx instead calls exit() inside the C library, so nothing at all is written.

mod common;

use common::*;
use transcriber::protocol::{ErrorCode, Message};

#[test]
fn review_truncated_tokens_file_gives_an_error_line() {
    let _g = heavy_lock();
    let src = model_dir().join("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");
    let d = temp_dir("review-truncated-tokens");
    let fam = d.join("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");
    std::fs::create_dir_all(&fam).unwrap();
    link(&model_dir().join("silero_vad.onnx"), &d.join("silero_vad.onnx"));
    for f in ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx"] {
        link(&src.join(f), &fam.join(f));
    }
    let tokens = std::fs::read(src.join("tokens.txt")).unwrap();
    std::fs::write(fam.join("tokens.txt"), &tokens[..tokens.len() / 2]).unwrap();

    let r = run(&["--model-dir", d.to_str().unwrap(), "--device", "cpu"], vec![0; 3200], Feed::AllAtOnce);
    let msgs: Vec<&Message> = r.msgs().collect();
    let _ = std::fs::remove_dir_all(&d);
    assert_eq!(msgs.len(), 1, "expected one error line, got {msgs:?} (exit {:?}); stderr:\n{}", r.status, r.stderr);
    assert!(
        matches!(msgs[0], Message::Error { code: ErrorCode::ModelLoadFailed | ErrorCode::ModelMissing, .. }),
        "{:?}",
        msgs[0]
    );
    assert_eq!(r.status.code(), Some(1));
}
