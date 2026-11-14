// Use in the native UI check after selecting a card and explicitly setting up
// its local model. The input is labelled synthetic microphone audio: this tests
// actual MediaRecorder -> WAV -> local inference -> draft, not room recording.
import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
export async function verifySpeechCapture(page, fixturePath) {
  const wav = (await readFile(fixturePath)).toString("base64"),
    draft = page.getByRole("textbox", {
      name: "Message to worker",
      exact: true,
    });
  await expect(draft).toBeVisible();
  const before = await page.evaluate(() => window.memcode.load()),
    beforeValue = await draft.inputValue();
  const duration = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const context = new AudioContext(),
      buffer = await context.decodeAudioData(bytes.buffer);
    window.__speechFixture = {
      context,
      buffer,
      streams: [],
      original: navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      ),
    };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const fixture = window.__speechFixture,
          destination = fixture.context.createMediaStreamDestination(),
          source = fixture.context.createBufferSource();
        source.buffer = fixture.buffer;
        source.connect(destination);
        await fixture.context.resume();
        source.start();
        fixture.streams.push(destination.stream);
        return destination.stream;
      },
    });
    return buffer.duration;
  }, wav);
  try {
    await page
      .getByRole("button", { name: "Dictate a note", exact: true })
      .click();
    await expect
      .poll(() => page.locator(".dictation-button.recording").count())
      .toBe(1);
    await page.waitForTimeout(
      Math.min(15000, Math.ceil(duration * 1000) + 150),
    );
    await page
      .getByRole("button", { name: "Dictate a note", exact: true })
      .click();
    await expect(draft).toHaveValue(
      /ask not what your country can do[\s\S]+what you can do for your country/i,
      { timeout: 30000 },
    );
    const after = await page.evaluate(() => window.memcode.load());
    const count = (state) =>
      state.tasks.reduce((sum, task) => sum + task.messages.length, 0);
    expect(count(after.state)).toBe(count(before.state));
    expect(after.state.tasks.some((task) => task.run.state === "running")).toBe(
      false,
    );
    expect(
      await page.evaluate(() =>
        window.__speechFixture.streams.every((stream) =>
          stream.getTracks().every((track) => track.readyState === "ended"),
        ),
      ),
    ).toBe(true);
    const transcript = await draft.inputValue();
    await page.evaluate(() =>
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          throw new DOMException(
            "Fixture permission denial",
            "NotAllowedError",
          );
        },
      }),
    );
    await page
      .getByRole("button", { name: "Dictate a note", exact: true })
      .click();
    await expect(page.getByText(/Microphone access was denied/)).toBeVisible();
    await expect(draft).toHaveValue(transcript);
    return {
      passed: true,
      input:
        "Labelled upstream speech fixture through synthetic microphone MediaStream",
      transcript,
      noAutosend: true,
      tracksStopped: true,
      permissionDenial: true,
      actualMicrophone: false,
      previousDraftPreserved: transcript.startsWith(beforeValue),
    };
  } finally {
    await page.evaluate(async () => {
      const fixture = window.__speechFixture;
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: fixture.original,
      });
      fixture.streams.forEach((stream) =>
        stream.getTracks().forEach((track) => track.stop()),
      );
      await fixture.context.close();
      delete window.__speechFixture;
    });
  }
}
