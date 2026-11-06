export default {
  id: 'asr-stream',
  title: 'ASR: legacy and streaming engine transport',
  summary: 'Two recognition turns inject text without microphone access and release simulated recorders.',
  build({ caps, lab }) {
    const heard = text => lab.logTail(240).some(line => line.includes(`[conformance] asr-result ${text}`));
    const turn = text => [
      { wake: 'inklab', label: 'Start recognition through the engine' },
      { wait: 700, label: 'Wait for recorder and speech session' },
      { expect: () => caps.speech.isListening() || 'Speech session did not start', label: 'Listening' },
      { do: () => { caps.speech.say(text); caps.speech.endTurn(); }, label: 'Inject transcript and end of speech' },
      { wait: 300, label: 'Drain recognition events' },
      { expect: () => heard(text) || `Engine did not deliver transcript: ${text}`, label: 'Application received transcript' },
      { expect: () => !caps.speech.isListening() || 'Speech session leaked', label: 'Recognition ended' },
      {
        expect: () => caps.media.recorders().length === 0 || 'Media recorder leaked after recognition',
        label: 'Recorder released',
      },
    ];
    return [
      ...turn('first simulated turn'),
      ...turn('second simulated turn'),
      { shot: 'asr-stream', label: 'Recognition transport proof' },
    ];
  },
};
