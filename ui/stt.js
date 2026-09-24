// Speech-to-text via the browser's Web Speech API (free, native in Chrome/Edge on localhost).
// Continuous dictation with interim results; auto-restarts when the engine stops on silence.
export function createSTT({ onFinal, onInterim, onState, lang } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return { supported: false, toggle() {}, stop() {}, get active() { return false; } };
  let rec = null;
  let wantActive = false;
  let failed = false;

  function start() {
    failed = false;
    const r = new SR();
    rec = r;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang || navigator.language || 'en-US';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const item = e.results[i];
        if (item.isFinal) onFinal?.(item[0].transcript.trim());
        else interim += item[0].transcript;
      }
      onInterim?.(interim.trim());
    };
    rec.onerror = (e) => {
      // 'no-speech' and 'aborted' are routine; permission errors end the session.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') { wantActive = false; failed = true; onState?.({ active: false, error: e.error }); }
      else if (e.error !== 'no-speech' && e.error !== 'aborted') { failed = true; onState?.({ active: wantActive, error: e.error }); }
    };
    rec.onend = () => {
      if (rec !== r) return;
      onInterim?.('');
      if (wantActive) { try { r.start(); } catch { setTimeout(() => wantActive && rec === r && start(), 300); } }
      else if (!failed) onState?.({ active: false }); // U2: keep a fatal error visible instead of clearing it
    };
    try { r.start(); onState?.({ active: true }); }
    catch (e) { wantActive = false; failed = true; onState?.({ active: false, error: e.message }); }
  }

  function stop() {
    wantActive = false;
    failed = false;
    try { rec?.stop(); } catch {}
    onInterim?.('');
    onState?.({ active: false });
  }

  return {
    supported: true,
    toggle() { if (wantActive) stop(); else { wantActive = true; start(); } },
    stop,
    get active() { return wantActive; },
  };
}

/** Insert dictated text at the caret of a textarea, with sensible spacing. */
export function insertAtCaret(ta, text) {
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(end);
  const needsSpace = before.length && !/\s$/.test(before);
  const piece = (needsSpace ? ' ' : '') + text + (after.length && !/^\s/.test(after) ? ' ' : '');
  ta.value = before + piece + after;
  const caret = before.length + piece.length;
  ta.setSelectionRange(caret, caret);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
