# Uncapped WebSocket starvation qualification

This is an executable runtime qualification for the Chromium scheduler fix.
It intentionally uses Chrome DevTools Protocol `Input.dispatchMouseEvent` so
mouse movement goes through Chromium's compositor/input pipeline. Electron's
`webContents.sendInputEvent()` is not an equivalent reproduction path.

Run it with the Electron binary under test:

```sh
path/to/electron script/uncapped-websocket-starvation/cdp-test.js 8085 PATCHED 12000
```

The harness appends the same two switches used by WOK:

```text
--disable-frame-rate-limit
--disable-gpu-vsync
```

During the run it holds the left mouse button, continuously dispatches circular
mouse movement, paints a canvas on every input event, runs a `requestAnimationFrame`
loop, sends local WebSocket messages, and posts messages from a dedicated Worker.
It reports WebSocket and Worker p50/p95/p99/max callback latency, messages over
50 ms, processed mouse events, frame count, FPS, and frame-time p95.

The qualification pass criterion is strict: both WebSocket and Worker messages
over 50 ms must be zero, and all three activity counters must be non-zero. The
optional `WS_STARVATION_MAX_OVER_50` environment variable exists only for a
documented noisy-host exception; normal qualification runs must leave it unset.

For the optional frame-throughput comparison, repeat the same run with the
feature parameter supplied before the script path:

```sh
path/to/electron --enable-features=CustomMaxPendingFrames:count/2 \
  script/uncapped-websocket-starvation/cdp-test.js 8085 COUNT2 12000
```

Record actual output from each binary. Do not treat a successful build or a
source patch as runtime qualification evidence.
