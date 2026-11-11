//! Executable docs: every fenced block in docs/graphspec.md whose info
//! string is exactly `yah check` must be a complete .yah file that
//! passes `graphloop check`. Fragments stay ```yah and are skipped.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn marked_blocks(spec: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut cur: Option<Vec<&str>> = None;
    for line in spec.lines() {
        match &mut cur {
            None => {
                if line.trim() == "```yah check" {
                    cur = Some(Vec::new());
                }
            }
            Some(buf) => {
                if line.trim() == "```" {
                    blocks.push(cur.take().unwrap().join("\n") + "\n");
                } else {
                    buf.push(line);
                }
            }
        }
    }
    blocks
}

#[test]
fn graphspec_yah_check_blocks_pass_check() {
    let spec_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("docs/graphspec.md");
    let spec = fs::read_to_string(&spec_path)
        .unwrap_or_else(|e| panic!("read {}: {e}", spec_path.display()));
    let blocks = marked_blocks(&spec);
    assert!(
        blocks.len() >= 3,
        "expected at least 3 ```yah check blocks in docs/graphspec.md, found {}",
        blocks.len()
    );

    let dir = std::env::temp_dir().join(format!(
        "graphloop-docs-check-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();

    let mut failure: Option<String> = None;
    for (i, block) in blocks.iter().enumerate() {
        let n = i + 1;
        let file = dir.join(format!("block-{n}.yah"));
        fs::write(&file, block).unwrap();
        let out = Command::new(env!("CARGO_BIN_EXE_h1"))
            .arg("check")
            .arg(&file)
            .output()
            .unwrap();
        if !out.status.success() {
            failure = Some(format!(
                "block {n} failed `graphloop check`: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
            break;
        }
    }
    let _ = fs::remove_dir_all(&dir);
    if let Some(f) = failure {
        panic!("{f}");
    }
}
