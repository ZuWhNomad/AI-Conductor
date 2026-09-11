// Speech-to-text via the browser's Web Speech API (free, native in Chrome/Edge on localhost).
// Continuous dictation with interim results; auto-restarts when the engine stops on silence.
export function createSTT({ onFinal, onInterim, onState, lang } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return { supported: false, toggle() {}, stop() {}, get active() { return false; } };
  let rec = null;
  let wantActive = false;

  function start() {
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang || navigator.language || 'en-US';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) onFinal?.(r[0].transcript.trim());
        else interim += r[0].transcript;
      }
      onInterim?.(interim.trim());
    };
    rec.onerror = (e) => {
      // 'no-speech' and 'aborted' are routine; permission errors end the session.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') { wantActive = false; onState?.({ active: false, error: e.error }); }
      else if (e.error !== 'no-speech' && e.error !== 'aborted') onState?.({ active: wantActive, error: e.error });
    };
    rec.onend = () => {
      onInterim?.('');
      if (wantActive) { try { rec.start(); } catch { setTimeout(() => wantActive && start(), 300); } }
      else onState?.({ active: false });
    };
    try { rec.start(); onState?.({ active: true }); }
    catch (e) { wantActive = false; onState?.({ active: false, error: e.message }); }
  }

  function stop() {
    wantActive = false;
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
