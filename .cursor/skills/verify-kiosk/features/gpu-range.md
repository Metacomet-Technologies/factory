# GPU range

GPU range lets a user switch the GPU history chart between the last hour, 24 hours, and 7 days.

## Sub-features

- `gpu-1h` is the default history window.
- `gpu-24h` requests 24 hours of samples.
- `gpu-7d` requests 7 days of samples.

## How to get to it (user POV)

- In the GPU card, choose `1h`, `24h`, or `7d` in the control labeled `GPU history range`.

## Driving it with verify.mjs

Preconditions:

- `verify.mjs doctor` succeeds for this `VERIFY_ROOT`.
- The GPU section labeled `GPU` has finished loading and shows a Utilization metric.

- **Default.** Load `http://127.0.0.1:4181/`. The browser requests `GET /v1/gpu?range=1h`. The `1h` toggle in `GPU history range` is pressed.
- **Day.** Choose `24h` inside the group named `GPU history range`. The browser requests `GET /v1/gpu?range=24h`, and `24h` is pressed.
- **Week.** Choose `7d` inside that same group. The browser requests `GET /v1/gpu?range=7d`, and `7d` is pressed.
- **Proof.** Save a screenshot that includes the GPU card and a text file of the three request URLs to `$VERIFY_ROOT/evidence/gpu-range/`.

## Gotchas

- `30d` is a usage range, not a GPU range. Choosing it inside `GPU history range` is not possible; the control does not offer it.
- The chart is lazy. `Loading GPU chart` can appear before `GPU utilization history`. Wait for the chart or the empty copy `No GPU history available.` before calling the range change done.
- Live `gpu.sample` events update the metric numbers and do not replace the history request. A changing utilization number is not proof that the range changed.
