/** Original chunk-only UTF-8 fixture calls; no payload or credential retention. */
export function createAiFixtureProducer(response, exchange) {
  let sequence = 0;
  const fact = {
    exchange,
    bytes: 0,
    writes: 0,
    endAt: null,
    endReturned: false,
    finishAt: null,
    writableFinished: false,
    closeAt: null,
    prematureClose: false,
    errored: false,
    callFailed: false,
  };
  response.once("finish", () => {
    fact.finishAt = ++sequence;
    fact.writableFinished = response.writableFinished;
  });
  response.once("close", () => {
    fact.closeAt = ++sequence;
    fact.prematureClose = !response.writableFinished;
  });
  response.once("error", () => {
    fact.errored = true;
  });
  function suppliedBytes(chunk) {
    return chunk === undefined ? 0 : Buffer.byteLength(chunk);
  }
  return {
    fact,
    get destroyed() {
      return response.destroyed;
    },
    write(chunk) {
      try {
        const result = response.write(chunk);
        fact.bytes += suppliedBytes(chunk);
        fact.writes++;
        return result;
      } catch (error) {
        fact.callFailed = true;
        throw error;
      }
    },
    end(chunk) {
      fact.endAt = ++sequence;
      try {
        const result = response.end(chunk);
        fact.bytes += suppliedBytes(chunk);
        fact.endReturned = true;
        return result;
      } catch (error) {
        fact.callFailed = true;
        throw error;
      }
    },
  };
}

/** Keep the original real-response destroyed guard and 15ms fixture cadence. */
export function sendAiFixtureFrames(response, frames, timers, index = 0) {
  if (response.destroyed) return;
  const frame = frames[index];
  response.write(
    `data: ${frame === "[DONE]" ? frame : JSON.stringify(frame)}\n\n`,
  );
  if (index === frames.length - 1) {
    response.end();
    return;
  }
  const timer = setTimeout(() => {
    timers.delete(timer);
    sendAiFixtureFrames(response, frames, timers, index + 1);
  }, 15);
  timers.add(timer);
}
