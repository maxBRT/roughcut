//! Review test (track transcriber-review): the GPU runtime DLLs are present and load, but CUDA
//! itself has no usable device (old driver, GPU disabled, or here: CUDA_VISIBLE_DEVICES=-1).
//! onnxruntime then silently runs the fp32 model on the processor. The protocol requires
//! `ready` to report the device actually used, with `fallback: true`.

mod common;

use common::*;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use transcriber::protocol::{Device, Message};

fn ready_without_a_cuda_device(device: &str) -> (Message, String) {
    let dir = model_dir();
    let mut child = Command::new(exe())
        .args(["--model-dir", dir.to_str().unwrap(), "--device", device])
        .env("CUDA_VISIBLE_DEVICES", "-1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let pcm = speech_pcm()[..16_000 * 2 * 3].to_vec();
    let feeder = std::thread::spawn(move || {
        let _ = stdin.write_all(&pcm);
    });
    let mut first = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut first).unwrap();
    let status = child.wait().unwrap();
    feeder.join().unwrap();
    let mut err = String::new();
    let _ = std::io::Read::read_to_string(&mut child.stderr.take().unwrap(), &mut err);
    assert!(status.success() || !first.is_empty(), "exit {status:?}\n{err}");
    (parse_line(first.trim()), err)
}

#[test]
fn review_no_cuda_device_reports_cpu_and_fallback() {
    let _g = heavy_lock();
    for device in ["gpu", "auto"] {
        let (ready, err) = ready_without_a_cuda_device(device);
        match ready {
            Message::Ready { device: d, fallback, model } => {
                assert_eq!(
                    (d, fallback),
                    (Device::Cpu, true),
                    "--device {device} with no CUDA device: ready says {d:?}/fallback {fallback} ({model}) \
                     although onnxruntime fell back to the processor\nstderr:\n{err}"
                );
            }
            other => panic!("first line {other:?}"),
        }
    }
}
