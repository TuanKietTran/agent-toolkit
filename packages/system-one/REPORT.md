# M3/M4 Report

This is policy distillation, not learning the owner's behaviour. The student is trained on labels emitted by the explicit R1/R2/R3 policy.
No prompt text is used or stored. No live logger was started. Every successful decision is a concrete usable model; NoModelAvailable is an error condition, not a label.
The student is slower than the hand-written policy in this slice, so this proves the harness, not a speed gain.

## Scenarios
- Counts: {'train': 8400, 'validation': 1800, 'test': 1800, 'ood': 3000}; situation balance: {'train': {'continuing': 2820, 'new': 2783, 'existing': 2797}, 'validation': {'new': 622, 'existing': 591, 'continuing': 587}, 'test': {'existing': 612, 'new': 595, 'continuing': 593}, 'ood': {'new': 1000, 'existing': 1000, 'continuing': 1000}}.
- Test agreement: 0.963333; OOD agreement: 0.955.
- Test fallback rate: 0.025; OOD fallback rate: 0.036333.
- Policy degraded levels test: {0: 1100, 2: 349, 4: 351} (share 0.388889); OOD: {0: 3000} (share 0.0).
- Test agreement by situation: {'continuing': 0.969646, 'existing': 0.970588, 'new': 0.94958}.
- Test agreement by policy rule: {'R1': 1.0, 'R2': 1.0, 'R3': 0.910204}.
- Test confusion matrix (policy -> student): {'claude-haiku-5-5->claude-haiku-5-5': 154, 'claude-haiku-5-5->claude-opus-5': 3, 'claude-haiku-5-5->claude-sonnet-5-5': 2, 'claude-haiku-5-5->gpt-5.5': 1, 'claude-haiku-5-5->gpt-6-luna': 6, 'claude-opus-5->claude-opus-5': 139, 'claude-opus-5->gpt-5.6-sol': 3, 'claude-sonnet-5->claude-sonnet-5': 100, 'claude-sonnet-5->gpt-5.5': 1, 'claude-sonnet-5->gpt-5.6-sol': 1, 'claude-sonnet-5->gpt-6-astra': 1, 'claude-sonnet-5-5->claude-sonnet-5-5': 165, 'claude-sonnet-5-5->gpt-5.5': 2, 'claude-sonnet-5-5->gpt-6-luna': 1, 'claude-sonnet-5-5->gpt-6.1-sol': 2, 'gpt-5.5->gpt-5.5': 97, 'gpt-5.5->gpt-6.1-sol': 1, 'gpt-5.6-luna->claude-haiku-5-5': 2, 'gpt-5.6-luna->claude-sonnet-5': 1, 'gpt-5.6-luna->claude-sonnet-5-5': 1, 'gpt-5.6-luna->gpt-5.5': 1, 'gpt-5.6-luna->gpt-5.6-luna': 118, 'gpt-5.6-sol->claude-opus-5': 7, 'gpt-5.6-sol->gpt-5.5': 2, 'gpt-5.6-sol->gpt-5.6-sol': 243, 'gpt-5.6-sol->gpt-6-luna': 2, 'gpt-5.6-sol->gpt-6-sol': 1, 'gpt-5.6-sol->gpt-6.1-sol': 1, 'gpt-6-astra->gpt-6-astra': 90, 'gpt-6-luna->claude-haiku-5-5': 4, 'gpt-6-luna->gpt-5.6-sol': 2, 'gpt-6-luna->gpt-6-luna': 251, 'gpt-6-luna->gpt-6.1-sol': 1, 'gpt-6-sol->claude-opus-5': 1, 'gpt-6-sol->claude-sonnet-5-5': 3, 'gpt-6-sol->gpt-5.5': 2, 'gpt-6-sol->gpt-6-sol': 121, 'gpt-6.1-sol->claude-haiku-5-5': 1, 'gpt-6.1-sol->claude-opus-5': 1, 'gpt-6.1-sol->claude-sonnet-5-5': 4, 'gpt-6.1-sol->gpt-5.5': 1, 'gpt-6.1-sol->gpt-5.6-luna': 1, 'gpt-6.1-sol->gpt-5.6-sol': 2, 'gpt-6.1-sol->gpt-6-luna': 1, 'gpt-6.1-sol->gpt-6.1-sol': 256}.
- OOD confusion matrix (policy -> student): {'claude-haiku-5-5->claude-haiku-5-5': 246, 'claude-haiku-5-5->claude-sonnet-5-5': 12, 'claude-haiku-5-5->gpt-5.6-luna': 7, 'claude-haiku-5-5->gpt-6-luna': 2, 'claude-opus-5->claude-haiku-5-5': 10, 'claude-opus-5->claude-opus-5': 237, 'claude-opus-5->claude-sonnet-5-5': 17, 'claude-opus-5->gpt-5.6-sol': 2, 'claude-sonnet-5->claude-sonnet-5': 96, 'claude-sonnet-5-5->claude-haiku-5-5': 6, 'claude-sonnet-5-5->claude-opus-5': 13, 'claude-sonnet-5-5->claude-sonnet-5-5': 239, 'claude-sonnet-5-5->gpt-6.1-sol': 2, 'gpt-5.5->claude-opus-5': 2, 'gpt-5.5->gpt-5.5': 155, 'gpt-5.6-luna->claude-haiku-5-5': 2, 'gpt-5.6-luna->gpt-5.5': 1, 'gpt-5.6-luna->gpt-5.6-luna': 162, 'gpt-5.6-sol->claude-opus-5': 3, 'gpt-5.6-sol->gpt-5.6-sol': 480, 'gpt-5.6-sol->gpt-6-luna': 7, 'gpt-5.6-sol->gpt-6.1-sol': 12, 'gpt-6-astra->gpt-6-astra': 148, 'gpt-6-luna->claude-haiku-5-5': 3, 'gpt-6-luna->gpt-6-luna': 449, 'gpt-6-luna->gpt-6.1-sol': 14, 'gpt-6-sol->claude-sonnet-5-5': 11, 'gpt-6-sol->gpt-6-sol': 143, 'gpt-6.1-sol->claude-haiku-5-5': 1, 'gpt-6.1-sol->claude-opus-5': 3, 'gpt-6.1-sol->claude-sonnet-5-5': 2, 'gpt-6.1-sol->gpt-5.6-sol': 3, 'gpt-6.1-sol->gpt-6.1-sol': 510}.

## Latency (microseconds per decision, pure Python JSON inference)
- Test policy median/p99: 19.5 / 49.8.
- Test student median/p99: 90.2 / 210.0.
- OOD policy median/p99: 19.7 / 49.1.
- OOD student median/p99: 95.7 / 183.4.

## Replay of real metadata inventory
- Decision points replayed: 8087.
- Continuing/existing policy holds actual model after catalog/source fix: {'low': {'n': 8061, 'holds': 8058, 'rate': 0.999628}, 'medium': {'n': 8061, 'holds': 8058, 'rate': 0.999628}, 'high': {'n': 8061, 'holds': 8058, 'rate': 0.999628}}.
- New exact policy matches by supplied hint: {'low': {'n': 26, 'matches': 6, 'rate': 0.230769}, 'medium': {'n': 26, 'matches': 13, 'rate': 0.5}, 'high': {'n': 26, 'matches': 4, 'rate': 0.153846}}.
- New actual model in union of low/medium/high picks: {'n': 26, 'matches': 23, 'rate': 0.884615}.
- Claude replay availability is Claude-only; pi replay allows the full catalog. This replay is descriptive only: the hint and quota headroom are not inferred from prompts and are synthetic/caller-supplied.

## Limits
- The student is supervised by the explicit policy, not by the owner's behaviour.
- complexity_hint is supplied by the caller; this slice does not derive it from prompts.
- quota headroom is synthetic for scenarios and replay; no live logger was started.
- The real history has too few switches to evaluate learned switching behaviour.
