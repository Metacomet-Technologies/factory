# Repository workflow

Before GitHub or Git authentication, run:

```sh
export GH_TOKEN="$AGENT_GH_TOKEN"
gh auth setup-git
```

Never print or commit the token. Work on a feature branch.

This repository is a Rust workspace. Run `cargo fmt --check`,
`cargo clippy --all-targets -- -D warnings`, and `cargo test --workspace` before pushing.
Do not run deployment scripts or change the running Ollama without explicit permission.
