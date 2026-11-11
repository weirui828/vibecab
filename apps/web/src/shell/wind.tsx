import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useFrame } from "../ui/useFrame.js";

// Wind: now and then one slow gust crosses the app. The plumb line leans, the cabs sway, and it can be heard,
// low and warm. Between gusts nothing moves on its own.

/** What everything that sways reads each frame. `level` swells from 0 to 1 and back over one gust. */
export interface Wind {
  level: number;
  /** Seconds on the wind's own clock; `from` is when the current gust began. */
  clock: number;
  from: number;
}

interface WindValue {
  wind: Wind;
  sound: boolean;
  setSound(on: boolean): void;
}

const still: WindValue = { wind: { level: 0, clock: 0, from: -100 }, sound: false, setSound: () => undefined };
const WindContext = createContext<WindValue>(still);
export const useWind = () => useContext(WindContext);

function readSound(): boolean {
  try {
    return localStorage.getItem("vc-wind-sound") !== "off";
  } catch {
    return true;
  }
}

interface Voice {
  context: AudioContext;
  gain: GainNode;
  filter: BiquadFilterNode;
}

/** Brown noise through a low-pass: a soft, low rush with no hiss. Silent until a gust opens it. */
function makeVoice(): Voice | undefined {
  const Ctor = window.AudioContext;
  if (typeof Ctor !== "function") return undefined;
  const context = new Ctor(),
    buffer = context.createBuffer(1, context.sampleRate * 4, context.sampleRate),
    data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[i] = last * 3.5;
  }
  const source = context.createBufferSource(),
    filter = context.createBiquadFilter(),
    gain = context.createGain();
  source.buffer = buffer;
  source.loop = true;
  filter.type = "lowpass";
  filter.frequency.value = 300;
  filter.Q.value = 0.3;
  gain.gain.value = 0;
  source.connect(filter).connect(gain).connect(context.destination);
  source.start();
  return { context, gain, filter };
}

export function WindProvider({ children }: { children: ReactNode }) {
  const wind = useRef<Wind>({ level: 0, clock: 0, from: -100 }).current,
    next = useRef(8),
    long = useRef(7),
    voice = useRef<Voice | undefined>(undefined),
    [sound, setSoundState] = useState(readSound),
    soundNow = useRef(sound);
  soundNow.current = sound;

  // Browsers only let a page make sound after the person has touched it.
  useEffect(() => {
    const wake = () => {
      if (soundNow.current) voice.current ??= makeVoice();
      void voice.current?.context.resume();
    };
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
      void voice.current?.context.close();
      voice.current = undefined;
    };
  }, []);

  useFrame((dt) => {
    wind.clock += dt;
    if (wind.clock >= next.current) {
      wind.from = wind.clock;
      long.current = 6.5 + Math.random() * 2.5;
      next.current = wind.clock + 24 + Math.random() * 26;
    }
    const part = (wind.clock - wind.from) / long.current;
    wind.level = part > 0 && part < 1 ? Math.sin(Math.PI * part) ** 2 : 0;
    const v = voice.current;
    if (!v) return;
    const now = v.context.currentTime;
    v.gain.gain.setTargetAtTime(soundNow.current ? wind.level * 0.085 : 0, now, 0.3);
    v.filter.frequency.setTargetAtTime(300 + wind.level * 360, now, 0.4);
  });

  const setSound = useCallback(
    (on: boolean) => {
      try {
        localStorage.setItem("vc-wind-sound", on ? "on" : "off");
      } catch {
        // Storage can be unavailable; the choice then lasts for this visit.
      }
      setSoundState(on);
      if (on) {
        voice.current ??= makeVoice();
        void voice.current?.context.resume();
        // Turning it on calls a gust, so there is something to hear.
        if (wind.level === 0) next.current = wind.clock;
      }
    },
    [wind],
  );
  const value = useMemo(() => ({ wind, sound, setSound }), [wind, sound, setSound]);
  return <WindContext.Provider value={value}>{children}</WindContext.Provider>;
}

/** How far a gust leans a hanging line at `s` (0 top, 1 bottom), in the line's own units: a swell that rolls down it. */
export function lean(wind: Wind, s: number): number {
  if (wind.level === 0) return 0;
  const roll = 0.75 + 0.25 * Math.sin(2 * Math.PI * 1.3 * s - 1.1 * (wind.clock - wind.from));
  return wind.level * Math.sin(Math.PI * s) * roll;
}
