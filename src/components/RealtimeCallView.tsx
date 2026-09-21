import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, PhoneOff, X } from "lucide-react";

import { useStore, visibleMessages, type Bot } from "@/state/store";
import { deferCallCleanup, endCall } from "@/lib/call";
import { OpenAIRealtimeProvider } from "@/lib/live-call-provider";
import { OpenAIRealtimeTransport } from "@/lib/openai-realtime-transport";
import { HttpVoiceTurnBridge } from "@/lib/voice-turn-bridge";
import { VoiceCallStateMachine, classifyMicrophoneError } from "@/lib/voice-call-state-machine";
import { openEchoCancelledMicrophone } from "@/lib/duplex-voice";
import { speaker } from "@/lib/tts";
import { spokenApprovalDecision } from "@/lib/spoken-approval";
import { pendingApprovals } from "./PendingApproval";
import { DaniAvatar } from "./Avatar";

export function RealtimeCallView({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const messages = visibleMessages(bot);
  const approval = pendingApprovals(messages)[0];
  const approvalRef = useRef(approval);
  approvalRef.current = approval;
  const spokenIds = useRef(new Set(messages.map((message) => message.id)));
  const [state, setState] = useState<"connecting" | "listening" | "thinking" | "speaking" | "reconnecting" | "error">("connecting");
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState("Cloud voice sends microphone audio to OpenAI for transcription. Agent work still runs through Hermes and Dani's approval controls.");
  const machineRef = useRef<VoiceCallStateMachine | null>(null);
  const transportRef = useRef<OpenAIRealtimeTransport | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const generationRef = useRef(0);
  const alive = useRef(true);
  const audioRef = useRef<HTMLAudioElement>(null);

  const hangup = useCallback(() => endCall(bot.id), [bot.id]);

  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    const callId = crypto.randomUUID();
    const bridge = new HttpVoiceTurnBridge(bot.id, bot.threadId);
    const machine = new VoiceCallStateMachine(callId, bridge);
    const provider = new OpenAIRealtimeProvider(true, () => new OpenAIRealtimeTransport());
    const transport = provider.createTransport() as OpenAIRealtimeTransport;
    machineRef.current = machine;
    transportRef.current = transport;
    generationRef.current = machine.start();
    const offState = machine.subscribe((snapshot) => {
      if (!alive.current || snapshot.state === "idle" || snapshot.state === "ended") return;
      setState(snapshot.state);
      if (snapshot.error) setNote(`${snapshot.error.message} ${snapshot.error.action}`);
    });
    const offTransport = transport.subscribe((event) => {
      if (!alive.current) return;
      const generation = generationRef.current;
      if (event.type === "state" && event.state === "connected") machine.connected(generation);
      else if (event.type === "transcript") {
        setHeard(event.text);
        if (event.final && event.utteranceId) {
          const open = approvalRef.current;
          const decision = open ? spokenApprovalDecision(event.text) : null;
          if (open && decision) {
            if (decision === "allow" && open.message.card?.skillRequest) {
              setNote("Open the chat to review the complete skill before enabling it. You can say no to deny it.");
            } else {
              dispatch({ type: "decideRequest", threadId: bot.threadId, requestId: open.requestId, behavior: decision, message: decision === "deny" ? "Denied by the user, on a call." : undefined });
            }
          } else if (open) {
            setNote("That was not an unambiguous yes or no. The approval remains pending.");
          } else {
            void machine.submitFinal(generation, { utteranceId: event.utteranceId, text: event.text });
          }
        }
      } else if (event.type === "speech" && event.active && (machine.snapshot.state === "thinking" || machine.snapshot.state === "speaking")) {
        speaker.stop();
        transport.interrupt();
        void machine.bargeIn(generation).then((next) => { if (next) generationRef.current = next; });
      } else if (event.type === "error") {
        machine.fail(event.code === "network-disconnected" ? "network-disconnected" : "provider-failed", event.message);
      }
    });
    void (async () => {
      try {
        const microphone = await openEchoCancelledMicrophone();
        if (abort.signal.aborted) { for (const track of microphone.getTracks()) track.stop(); return; }
        microphoneRef.current = microphone;
        const session = await provider.createSession({ conversationId: bot.threadId, participants: [{ id: bot.id, name: bot.name, instructions: bot.description, voice: bot.voice }] }, abort.signal);
        const remote = await transport.connect(session, microphone);
        if (audioRef.current && !abort.signal.aborted) {
          audioRef.current.srcObject = remote;
          await audioRef.current.play();
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        const failure = error instanceof DOMException ? classifyMicrophoneError(error) : null;
        machine.fail(failure?.code ?? "provider-failed", failure?.message ?? (error instanceof Error ? error.message : "Voice call failed"), error);
      }
    })();
    return () => {
      alive.current = false;
      abort.abort();
      offTransport();
      offState();
      machine.end();
      transport.close();
      for (const track of microphoneRef.current?.getTracks() ?? []) track.stop();
      microphoneRef.current = null;
      if (audioRef.current) { audioRef.current.pause(); audioRef.current.srcObject = null; }
      deferCallCleanup(bot.id, () => alive.current);
    };
  }, [bot.description, bot.id, bot.name, bot.threadId, bot.voice, dispatch]);

  useEffect(() => {
    const machine = machineRef.current;
    if (!machine) return;
    const fresh = messages.filter((message) => !spokenIds.current.has(message.id));
    for (const message of fresh) spokenIds.current.add(message.id);
    const reply = [...fresh].reverse().find((message) => message.role === "bot" && message.kind === "text" && message.text?.trim());
    const activity = [...fresh].reverse().find((message) => message.kind === "activity" && message.tool?.spoken);
    const text = reply?.text?.trim() || activity?.tool?.spoken?.trim();
    if (!text || approval) return;
    const generation = generationRef.current;
    if (!machine.markSpeaking(generation)) return;
    void speaker.speak(text, { botId: bot.id, voiceId: bot.voice }).finally(() => {
      if (alive.current) machine.markListening(generationRef.current);
    });
  }, [approval, bot.id, bot.voice, messages]);

  const interrupt = useCallback(() => {
    const machine = machineRef.current;
    if (!machine) return;
    speaker.stop();
    transportRef.current?.interrupt();
    void machine.bargeIn(generationRef.current).then((next) => { if (next) generationRef.current = next; });
  }, []);

  const status = state === "connecting" ? "Connecting" : state === "listening" ? "Listening" : state === "thinking" ? "Working" : state === "speaking" ? bot.name : state === "reconnecting" ? "Reconnecting" : "Call needs attention";
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-app/95 backdrop-blur-sm">
      <audio ref={audioRef} autoPlay />
      <button onClick={hangup} aria-label="Hang up" className="absolute right-5 top-5 rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink"><X size={18} /></button>
      <DaniAvatar color={bot.color} bodyId={bot.mascotBody ?? undefined} state={state === "listening" ? "listening" : state === "speaking" ? "sending" : "working"} size={220} animated trackPointer />
      <div className="flex flex-col items-center gap-1.5 text-center"><div className="text-[20px] font-medium text-ink">{bot.name}</div><div className="flex items-center gap-2 text-[13.5px] text-ink-secondary">{(["connecting", "thinking", "reconnecting"] as string[]).includes(state) && <Loader2 size={13} className="animate-spin" />}{status}</div></div>
      <div className="min-h-[3.5rem] max-w-[560px] px-6 text-center text-[15px] leading-relaxed text-ink">{heard || <span className="text-ink-secondary">Say something…</span>}</div>
      <div className="max-w-[560px] text-center text-[11.5px] text-ink-secondary/80">{note}</div>
      <div className="flex items-center gap-3">{(state === "thinking" || state === "speaking") && <button onClick={interrupt} className="rounded-full border border-hairline/50 px-4 py-2 text-[13.5px] text-ink hover:bg-raised">Interrupt</button>}<button onClick={hangup} className="flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-[14px] font-medium text-white hover:brightness-110"><PhoneOff size={16} /> Hang up</button></div>
    </div>
  );
}
