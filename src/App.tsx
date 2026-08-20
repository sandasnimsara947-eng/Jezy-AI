/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import type { LiveServerMessage } from "@google/genai";
import { Mic, MicOff, Camera, CameraOff, Power, Loader2, ExternalLink, Bluetooth, Volume2, Check, Radio, RefreshCw, SlidersHorizontal, VolumeX, Sparkles, Activity } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Jarvis-style colors
const COLORS = {
  bg: '#050505',
  accent: '#00F0FF', // Cyan glow
  accentDim: 'rgba(0, 240, 255, 0.2)',
  danger: '#FF4444',
};

export default function App() {
  const [isActive, setIsActive] = useState(false);
  const isActiveRef = useRef(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const isConnectingRef = useRef(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);
  const [status, setStatus] = useState('System Offline');
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [isVisualizing, setIsVisualizing] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const retryCountRef = useRef(0);
  const MAX_RETRIES = 5;

  // Audio Devices & Voice System state
  const [selectedVoice, setSelectedVoice] = useState<string>('Fenrir');
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>('default');
  const [showAudioMenu, setShowAudioMenu] = useState(false);
  const [activeBluetoothSpeakerLabel, setActiveBluetoothSpeakerLabel] = useState<string | null>(null);
  const [micVolumeLevel, setMicVolumeLevel] = useState<number>(0);
  const [isScanningDevices, setIsScanningDevices] = useState(false);
  const [deviceToastMsg, setDeviceToastMsg] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const audioOutputRef = useRef<HTMLAudioElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioWorkletNodeRef = useRef<AudioWorkletNode | null>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const nextStartTimeRef = useRef<number>(0);
  const activeAudioSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  // Fetch available audio output devices (Bluetooth speakers, headsets, external speakers)
  const refreshAudioDevices = useCallback(async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    setIsScanningDevices(true);
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(d => d.kind === 'audiooutput');
      setOutputDevices(outputs);

      // Detect Bluetooth speaker
      const btSpeaker = outputs.find(d => 
        /bluetooth|wireless|headset|hands-free|airpods|buds|speaker|a2dp/i.test(d.label)
      );
      if (btSpeaker) {
        setActiveBluetoothSpeakerLabel(btSpeaker.label || 'Bluetooth Speaker / Headset');
      } else {
        setActiveBluetoothSpeakerLabel(null);
      }
    } catch (e) {
      console.warn('Could not enumerate audio devices:', e);
    } finally {
      setTimeout(() => setIsScanningDevices(false), 400);
    }
  }, []);

  // Listen for audio device change events
  useEffect(() => {
    refreshAudioDevices();
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', refreshAudioDevices);
      return () => {
        navigator.mediaDevices.removeEventListener('devicechange', refreshAudioDevices);
      };
    }
  }, [refreshAudioDevices]);

  // Apply selected audio output device (Bluetooth Speaker / Headphones)
  const applyAudioOutputDevice = async (deviceId: string) => {
    setSelectedSpeakerId(deviceId);
    const matched = outputDevices.find(d => d.deviceId === deviceId);
    const label = matched?.label || (deviceId === 'default' ? 'Default Speaker' : 'Speaker');
    setDeviceToastMsg(`Speaker Set: ${label.slice(0, 24)}`);
    setTimeout(() => setDeviceToastMsg(null), 3000);

    // 1. Apply to AudioContext if setSinkId is supported
    if (audioContextRef.current && 'setSinkId' in audioContextRef.current) {
      try {
        await (audioContextRef.current as any).setSinkId(deviceId);
      } catch (e) {
        console.warn('AudioContext setSinkId error:', e);
      }
    }

    // 2. Apply to HTML Audio Element proxy for Bluetooth SCO/A2DP mobile routing
    if (audioOutputRef.current && 'setSinkId' in audioOutputRef.current) {
      try {
        await (audioOutputRef.current as any).setSinkId(deviceId);
      } catch (e) {
        console.warn('HTMLAudioElement setSinkId error:', e);
      }
    }
  };

  // Test audio output chime through Bluetooth speaker / selected output
  const testAudioSignal = () => {
    if (!audioContextRef.current) return;
    const ctx = audioContextRef.current;
    if (ctx.state === 'suspended') ctx.resume();

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
    osc2.frequency.setValueAtTime(659.25, ctx.currentTime); // E5

    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);

    osc1.connect(gain);
    osc2.connect(gain);
    
    // Exclusive single audio route to prevent double voice / echo
    if (mediaStreamDestRef.current && audioOutputRef.current && audioOutputRef.current.srcObject) {
      gain.connect(mediaStreamDestRef.current);
    } else {
      gain.connect(ctx.destination);
    }

    osc1.start(ctx.currentTime);
    osc2.start(ctx.currentTime + 0.12);
    osc1.stop(ctx.currentTime + 0.5);
    osc2.stop(ctx.currentTime + 0.5);
  };

  // Initialize Audio Context with Dual WebAudio + HTML Audio Element MediaStream routing
  const initAudio = async () => {
    if (!audioContextRef.current) {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextRef.current = ctx;
      nextStartTimeRef.current = 0;

      // Create MediaStream destination for mobile Bluetooth SCO/A2DP routing
      try {
        mediaStreamDestRef.current = ctx.createMediaStreamDestination();
        if (audioOutputRef.current) {
          audioOutputRef.current.srcObject = mediaStreamDestRef.current.stream;
          audioOutputRef.current.play().catch(() => {});
        }
      } catch (e) {
        console.warn('MediaStream destination node creation error:', e);
      }
    }

    if (audioContextRef.current.state === 'suspended') {
      try {
        await audioContextRef.current.resume();
      } catch (e) {
        console.error('Failed to resume audio context:', e);
      }
    }

    // Refresh devices after user gesture
    refreshAudioDevices();
  };

  const playQueuedAudio = useCallback(() => {
    if (!audioContextRef.current || audioQueueRef.current.length === 0) return;

    const now = audioContextRef.current.currentTime;
    
    // If we've fallen behind, reset the clock
    if (nextStartTimeRef.current < now) {
      nextStartTimeRef.current = now + 0.01; // Reduced buffer to 10ms for instant starts
    }

    while (audioQueueRef.current.length > 0) {
      const chunk = audioQueueRef.current.shift()!;
      const buffer = audioContextRef.current.createBuffer(1, chunk.length, 24000);
      buffer.copyToChannel(chunk, 0);

      const source = audioContextRef.current.createBufferSource();
      source.buffer = buffer;

      // Exclusive single audio route directly to output to prevent double voice / echo
      if (mediaStreamDestRef.current && audioOutputRef.current && audioOutputRef.current.srcObject) {
        source.connect(mediaStreamDestRef.current);
      } else {
        source.connect(audioContextRef.current.destination);
      }
      
      source.start(nextStartTimeRef.current);
      nextStartTimeRef.current += buffer.duration;
      
      // Keep track of the active sources to allow stopping on interruption
      activeAudioSourcesRef.current.push(source);
      source.onended = () => {
        activeAudioSourcesRef.current = activeAudioSourcesRef.current.filter(s => s !== source);
      };
    }
  }, []);

  const handleAudioOutput = useCallback((base64Data: string) => {
    if (!audioContextRef.current) return;
    
    const binaryString = atob(base64Data);
    const len = binaryString.length;
    const bytes = new Int16Array(len / 2);
    for (let i = 0; i < len; i += 2) {
      bytes[i / 2] = (binaryString.charCodeAt(i + 1) << 8) | binaryString.charCodeAt(i);
    }
    // Convert Int16 to Float32
    const float32 = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      float32[i] = bytes[i] / 32768.0;
    }
    audioQueueRef.current.push(float32);
    playQueuedAudio();
  }, [playQueuedAudio]);

  const cleanupWsOnly = () => {
    if (wsRef.current) {
      try {
        wsRef.current.onopen = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.close();
      } catch (e) {}
      wsRef.current = null;
    }
    audioQueueRef.current = [];
    nextStartTimeRef.current = 0;
    activeAudioSourcesRef.current.forEach((src) => {
      try {
        src.stop();
      } catch (e) {}
    });
    activeAudioSourcesRef.current = [];
    setIsThinking(false);
  };

  const handleSessionClose = (reason: string, isGoAway = false) => {
    if (isActiveRef.current || isConnectingRef.current) {
      console.warn('Jarvis Link Severed:', reason);
      const isOnline = navigator.onLine;
      const isSessionRefresh = isGoAway || /goaway|duration limit|session limit|aborted|refreshed/i.test(reason);

      cleanupWsOnly();
      setIsConnecting(false);
      isConnectingRef.current = false;

      if (isSessionRefresh) {
        setStatus('Refreshing Neural Session...');
        setErrorDetail(null);
        retryCountRef.current = 0;
        setTimeout(() => {
          if (isActiveRef.current || isConnectingRef.current) {
            startSession(true, 0);
          }
        }, 300);
        return;
      }

      const statusMsg = !isOnline ? 'Network Offline' : (reason || 'Link Severed');
      setErrorDetail(`Connection closed. ${!isOnline ? 'Check your internet connection.' : 'Re-establishing session...'}`);

      if (retryCountRef.current < MAX_RETRIES) {
        const nextRetry = retryCountRef.current + 1;
        retryCountRef.current = nextRetry;
        setStatus(`Link Unstable: ${statusMsg}. Retrying in ${Math.pow(2, nextRetry)}s...`);
        setTimeout(() => startSession(true, nextRetry), 1000 * Math.pow(2, nextRetry));
      } else {
        setStatus(`Neural Link Failed: ${statusMsg}`);
        stopSession();
      }
    }
  };

  const handleSessionError = (errorMessage: string, isGoAway = false) => {
    const lower = (errorMessage || '').toLowerCase();
    const isSessionRefresh = isGoAway || /goaway|duration limit|session limit|aborted/i.test(lower);
    if (isSessionRefresh) {
      handleSessionClose(errorMessage, true);
      return;
    }

    const isPermissionError = 
      lower.includes('permission') || 
      lower.includes('403') || 
      lower.includes('401') || 
      lower.includes('404') || 
      lower.includes('key missing') || 
      lower.includes('forbidden') || 
      lower.includes('unauthorized') || 
      lower.includes('quota');
    console.error('Jarvis Error:', errorMessage);
    const isOnline = navigator.onLine;
    setErrorDetail(errorMessage || 'WebSocket connection error');
    const statusMsg = isPermissionError 
      ? 'Access Denied / Permission Error' 
      : (!isOnline ? 'Network Offline' : (errorMessage.includes('Network') ? 'Network Error' : 'Internal Error'));
    
    cleanupWsOnly();
    setIsConnecting(false);
    isConnectingRef.current = false;

    if (!isPermissionError && retryCountRef.current < MAX_RETRIES) {
      const nextRetry = retryCountRef.current + 1;
      retryCountRef.current = nextRetry;
      setStatus(`Link Unstable: ${statusMsg}. Retrying in ${Math.pow(2, nextRetry)}s...`);
      setTimeout(() => startSession(true, nextRetry), 1000 * Math.pow(2, nextRetry));
    } else {
      setStatus(`Neural Link Failed: ${statusMsg}`);
      stopSession();
    }
  };

  const startSession = async (isRetry = false, retryNum?: number) => {
    try {
      const currentRetry = retryNum !== undefined ? retryNum : retryCountRef.current;
      if (!isRetry) {
        setIsConnecting(true);
        isConnectingRef.current = true;
        retryCountRef.current = 0;
      } else {
        setIsConnecting(true);
        isConnectingRef.current = true;
      }
      
      setStatus(isRetry ? `Retrying Link (${currentRetry + 1}/${MAX_RETRIES})...` : 'Initializing Neural Link...');
      setErrorDetail(null);
      
      await initAudio();

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/live?voice=${encodeURIComponent(selectedVoice)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[Client] Connected to server WebSocket proxy');
      };

      ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'open') {
            console.log('Jarvis Neural Link Established');
            setIsActive(true);
            isActiveRef.current = true;
            setIsConnecting(false);
            isConnectingRef.current = false;
            retryCountRef.current = 0;
            setStatus('Neural Link Active');
            startMediaStreams();
          } else if (data.type === 'message') {
            const message: LiveServerMessage = data.message;
            if (message.serverContent?.modelTurn) {
              const audioPart = message.serverContent.modelTurn.parts.find(p => p.inlineData);
              if (audioPart?.inlineData?.data) {
                handleAudioOutput(audioPart.inlineData.data);
              }
            }
            if (message.serverContent?.interrupted) {
              audioQueueRef.current = [];
              nextStartTimeRef.current = 0;
              setIsThinking(false);
              activeAudioSourcesRef.current.forEach((src) => {
                try {
                  src.stop();
                } catch (e) {}
              });
              activeAudioSourcesRef.current = [];
            }
            if (message.serverContent?.turnComplete) {
              setIsThinking(false);
            }
          } else if (data.type === 'close') {
            handleSessionClose(data.reason || 'Link Severed', !!data.isGoAway);
          } else if (data.type === 'error') {
            handleSessionError(data.error || 'Unknown Error', !!data.isGoAway);
          }
        } catch (e) {
          console.error('[Client] Invalid WebSocket message:', e);
        }
      };

      ws.onclose = (event) => {
        if (isActiveRef.current || isConnectingRef.current) {
          handleSessionClose(event?.reason || 'Link Severed');
        }
      };

      ws.onerror = (err) => {
        console.warn('Jarvis WS Error:', err);
        if (isActiveRef.current || isConnectingRef.current) {
          handleSessionError('WebSocket Connection Failure');
        }
      };

    } catch (error) {
      console.error('Failed to start Jarvis:', error);
      handleSessionError(error instanceof Error ? error.message : String(error));
    }
  };

  const stopSession = () => {
    setIsActive(false);
    isActiveRef.current = false;
    setIsConnecting(false);
    isConnectingRef.current = false;
    setStatus('System Offline');
    
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch (e) {}
      wsRef.current = null;
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try {
        audioContextRef.current.suspend();
      } catch (e) {}
    }
    
    audioQueueRef.current = [];
    nextStartTimeRef.current = 0;
    activeAudioSourcesRef.current.forEach((src) => {
      try {
        src.stop();
      } catch (e) {}
    });
    activeAudioSourcesRef.current = [];
    setIsCameraOn(false);
    setIsMicOn(false);
    setIsThinking(false);
  };

  const startMediaStreams = async () => {
    try {
      if (streamRef.current && streamRef.current.getTracks().some(t => t.readyState === 'live')) {
        if (videoRef.current && !videoRef.current.srcObject) {
          videoRef.current.srcObject = streamRef.current;
        }
        return;
      }

      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 24000
      };

      let stream: MediaStream | null = null;
      let cameraAvailable = false;

      // 1. Try rear camera + audio
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' },
          audio: audioConstraints
        });
        cameraAvailable = true;
      } catch (e1) {
        // 2. Try default camera + audio
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: audioConstraints
          });
          cameraAvailable = true;
        } catch (e2) {
          // 3. Fall back to audio only if camera is unavailable or denied
          stream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints
          });
          cameraAvailable = false;
        }
      }

      if (stream) {
        streamRef.current = stream;
        if (videoRef.current && cameraAvailable) {
          videoRef.current.srcObject = stream;
        }
        setIsCameraOn(cameraAvailable);
        setIsMicOn(true);
      }

      // Refresh device list after media permissions granted
      refreshAudioDevices();
    } catch (error) {
      console.error('Media Access Denied:', error);
      setStatus('Media Error');
    }
  };

  useEffect(() => {
    const handleOnline = () => setStatus('Network Restored');
    const handleOffline = () => setStatus('Network Offline');
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Audio capture
  useEffect(() => {
    if (!isActive || !isMicOn || !audioContextRef.current || !streamRef.current) return;

    const audioSource = audioContextRef.current.createMediaStreamSource(streamRef.current);
    const filter = audioContextRef.current.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 100; // Remove low-frequency rumble
    
    const processor = audioContextRef.current.createScriptProcessor(8192, 1, 1);
    
    processor.onaudioprocess = (e) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !isMicOn || !isActiveRef.current) return;
      const inputData = e.inputBuffer.getChannelData(0);
      
      // Simple volume detection
      let sum = 0;
      for (let i = 0; i < inputData.length; i++) {
        sum += inputData[i] * inputData[i];
      }
      const volume = Math.sqrt(sum / inputData.length);
      setMicVolumeLevel(Math.min(100, Math.round(volume * 600))); // Live audio input meter for Bluetooth Mic

      // Ignore acoustic echo while Jezy AI is speaking to prevent double/duplicate responses
      const isAISpeaking = activeAudioSourcesRef.current.length > 0 || audioQueueRef.current.length > 0;
      const speechThreshold = isAISpeaking ? 0.08 : 0.015; // Higher threshold when AI is speaking to prevent self-interruption from speaker output
      const isSilent = volume < speechThreshold;
      setIsListening(!isSilent);

      // Only interrupt if user explicitly speaks over AI at a higher volume threshold
      if (!isSilent && isAISpeaking && volume >= 0.08) {
        audioQueueRef.current = [];
        nextStartTimeRef.current = 0;
        activeAudioSourcesRef.current.forEach((src) => {
          try {
            src.stop();
          } catch (err) {}
        });
        activeAudioSourcesRef.current = [];
      }

      const pcmData = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        // Mute sending during AI speech if volume is below active user interruption threshold to avoid echo loops
        const sample = (isSilent || (isAISpeaking && volume < 0.08)) ? 0 : inputData[i];
        pcmData[i] = Math.max(-1, Math.min(1, sample)) * 0x7FFF;
      }
      const bytes = new Uint8Array(pcmData.buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);
      try {
        wsRef.current.send(JSON.stringify({
          realtimeInput: {
            audio: { data: base64, mimeType: 'audio/pcm;rate=24000' }
          }
        }));
      } catch (sendError) {
        console.error('Failed to send audio:', sendError);
      }
    };

    audioSource.connect(filter);
    filter.connect(processor);
    
    // Mute mic feedback destination to prevent acoustic loopback through speakers
    const silenceGain = audioContextRef.current.createGain();
    silenceGain.gain.value = 0;
    processor.connect(silenceGain);
    silenceGain.connect(audioContextRef.current.destination);

    return () => {
      try {
        processor.disconnect();
        filter.disconnect();
        audioSource.disconnect();
        silenceGain.disconnect();
      } catch (e) {}
    };
  }, [isActive, isMicOn]);

  // Video capture loop
  useEffect(() => {
    let timeoutId: any;
    const captureFrame = () => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !isActive || !isCameraOn || !videoRef.current || !canvasRef.current) {
        setIsVisualizing(false);
        timeoutId = setTimeout(captureFrame, 1000);
        return;
      }
      
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');
      const video = videoRef.current;
      if (canvas && context && video && video.readyState >= 2 && video.videoWidth > 0) {
        setIsVisualizing(true);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const base64 = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
        try {
          wsRef.current.send(JSON.stringify({
            realtimeInput: {
              video: { data: base64, mimeType: 'image/jpeg' }
            }
          }));
        } catch (videoError) {
          console.error('Failed to send video:', videoError);
        }
      }
      timeoutId = setTimeout(captureFrame, 1500); // Further throttled for network stability
    };

    if (isActive) {
      captureFrame();
    }

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [isActive, isCameraOn]);

  const toggleMic = () => {
    const nextState = !isMicOn;
    setIsMicOn(nextState);
    if (streamRef.current) {
      streamRef.current.getAudioTracks().forEach(t => { t.enabled = nextState; });
    }
  };

  const toggleCamera = () => {
    const nextState = !isCameraOn;
    setIsCameraOn(nextState);
    if (streamRef.current) {
      streamRef.current.getVideoTracks().forEach(t => { t.enabled = nextState; });
    }
  };

  const togglePower = () => {
    if (isActive) stopSession();
    else startSession();
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 font-sans transition-colors duration-500 relative" style={{ backgroundColor: COLORS.bg, color: COLORS.accent }}>
      
      {/* Toast Notification for Bluetooth / Audio device selection */}
      <AnimatePresence>
        {deviceToastMsg && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.9 }}
            className="fixed top-6 right-6 z-50 bg-black/90 border border-cyan-400/80 px-4 py-2.5 rounded-2xl shadow-[0_0_20px_rgba(0,240,255,0.3)] text-xs font-mono text-cyan-300 flex items-center gap-2 backdrop-blur-xl"
          >
            <Bluetooth size={14} className="text-cyan-400 animate-pulse shrink-0" />
            <span>{deviceToastMsg}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* HUD Overlay */}
      <div className="fixed top-8 left-8 flex flex-col gap-2 z-40">
        <div className="flex items-center gap-2 text-xs tracking-[0.2em] uppercase opacity-60">
          <div className={`w-2 h-2 rounded-full ${isActive ? 'bg-cyan-400 animate-pulse' : 'bg-red-500'}`} />
          {status}
          {!isActive && !isConnecting && (
            <button 
              onClick={() => startSession()}
              className="ml-2 px-2 py-0.5 border border-cyan-400/30 rounded hover:bg-cyan-400/10 transition-colors cursor-pointer"
            >
              RECONNECT
            </button>
          )}
        </div>
        {errorDetail && (
          <div className="text-[10px] text-red-400 font-mono max-w-xs opacity-80">
            ERROR: {errorDetail.toUpperCase()}
          </div>
        )}
        <div className="text-[10px] font-mono opacity-60 flex flex-wrap gap-4 items-center">
          <span>LATENCY: 42MS</span>
          <span>UPLINK: STABLE</span>
          
          {/* Active Bluetooth Speaker status badge */}
          {activeBluetoothSpeakerLabel ? (
            <button 
              onClick={() => { setShowAudioMenu(true); refreshAudioDevices(); }}
              className="flex items-center gap-1.5 text-cyan-400 font-bold opacity-100 hover:underline cursor-pointer bg-cyan-950/40 border border-cyan-400/40 px-2 py-0.5 rounded-md"
              title="Bluetooth Speaker Active"
            >
              <Volume2 size={11} className="text-cyan-400 animate-pulse" />
              <span>SPK: {activeBluetoothSpeakerLabel.slice(0, 16).toUpperCase()}</span>
            </button>
          ) : (
            <button 
              onClick={() => { setShowAudioMenu(true); refreshAudioDevices(); }}
              className="flex items-center gap-1 hover:text-cyan-400 cursor-pointer"
            >
              <Volume2 size={10} />
              <span>SPK: SYSTEM</span>
            </button>
          )}

          <button 
            onClick={() => window.open(window.location.href, '_blank')}
            className="flex items-center gap-1 hover:text-cyan-400 transition-colors cursor-pointer"
          >
            <ExternalLink size={10} />
            LAUNCH FULL INTERFACE
          </button>
          {isVisualizing && <motion.span animate={{ opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 1 }} className="text-cyan-400">VISUALIZING...</motion.span>}
          {isListening && <motion.span animate={{ opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 0.5 }} className="text-yellow-400 font-bold">ASKING QUESTION...</motion.span>}
        </div>
      </div>

      {/* Hidden Audio Proxy Element for Mobile Bluetooth SCO/A2DP Routing */}
      <audio ref={audioOutputRef} autoPlay playsInline className="hidden" />

      {/* Main Interface */}
      <div className="relative w-full max-w-2xl aspect-video rounded-3xl overflow-hidden border border-white/10 bg-black/40 backdrop-blur-xl shadow-2xl shadow-cyan-500/10">
        
        {/* Camera Feed */}
        <div className="relative w-full h-full">
          <video 
            ref={videoRef} 
            autoPlay 
            playsInline 
            muted 
            className={`w-full h-full object-cover transition-opacity duration-1000 ${isCameraOn ? 'opacity-40' : 'opacity-0'}`}
          />
          {isVisualizing && (
            <motion.div 
              className="absolute inset-0 bg-cyan-400/5 pointer-events-none"
              animate={{ opacity: [0, 0.2, 0] }}
              transition={{ duration: 1.5, repeat: Infinity }}
            />
          )}
        </div>
        <canvas ref={canvasRef} width="320" height="240" className="hidden" />

        {/* HUD Graphics */}
        <div className="absolute inset-0 pointer-events-none border-[20px] border-transparent border-t-white/5 border-b-white/5">
          <div className="absolute top-4 right-4 flex gap-4">
            <div className="w-12 h-1 bg-white/10 rounded-full overflow-hidden">
              <motion.div 
                className="h-full bg-cyan-400"
                animate={{ width: isActive ? ['20%', '80%', '40%'] : '0%' }}
                transition={{ duration: 2, repeat: Infinity }}
              />
            </div>
          </div>
          
          {/* Corner Brackets */}
          <div className="absolute top-8 left-8 w-8 h-8 border-t-2 border-l-2 border-cyan-400/30" />
          <div className="absolute top-8 right-8 w-8 h-8 border-t-2 border-r-2 border-cyan-400/30" />
          <div className="absolute bottom-8 left-8 w-8 h-8 border-b-2 border-l-2 border-cyan-400/30" />
          <div className="absolute bottom-8 right-8 w-8 h-8 border-b-2 border-r-2 border-cyan-400/30" />
        </div>

        {/* Central Visualizer (Arc Reactor Style) */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="relative w-48 h-48">
            {/* Outer Ring */}
            <motion.div 
              className="absolute inset-0 rounded-full border-2 border-dashed border-cyan-400/20"
              animate={{ rotate: 360 }}
              transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
            />
            {/* Inner Ring */}
            <motion.div 
              className={`absolute inset-4 rounded-full border ${isThinking ? 'border-cyan-400' : 'border-cyan-400/40'}`}
              animate={{ 
                scale: isActive ? [1, 1.1, 1] : 1,
                boxShadow: isThinking ? ['0 0 10px #00F0FF', '0 0 30px #00F0FF', '0 0 10px #00F0FF'] : 'none'
              }}
              transition={{ duration: isThinking ? 0.3 : 1, repeat: Infinity }}
            />
            {/* Core */}
            <div className="absolute inset-16 rounded-full bg-cyan-400/10 flex items-center justify-center backdrop-blur-sm">
              <AnimatePresence mode="wait">
                {isConnecting ? (
                  <motion.div
                    key="loading"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    <Loader2 className="w-8 h-8 animate-spin text-cyan-400" />
                  </motion.div>
                ) : (
                  <motion.div
                    key="power"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    <Power className={`w-8 h-8 ${isActive ? 'text-cyan-400 drop-shadow-[0_0_10px_rgba(34,211,238,0.8)]' : 'text-white/20'}`} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="mt-12 flex items-center gap-6 sm:gap-8 relative z-50">
        <button
          onClick={toggleMic}
          disabled={!isActive}
          className={`p-4 rounded-full border transition-all duration-300 ${isMicOn ? 'border-cyan-400 text-cyan-400 bg-cyan-400/10' : 'border-white/10 text-white/20'} disabled:opacity-20 cursor-pointer`}
          title="Toggle Microphone"
        >
          {isMicOn ? <Mic className="w-6 h-6" /> : <MicOff className="w-6 h-6" />}
        </button>

        <button
          onClick={togglePower}
          disabled={isConnecting}
          className={`group relative w-20 h-20 rounded-full flex items-center justify-center transition-all duration-500 ${isActive ? 'bg-cyan-400 text-black scale-110 shadow-[0_0_30px_rgba(34,211,238,0.4)]' : 'bg-white/5 text-white/40 hover:bg-white/10'} cursor-pointer`}
          title="Jezy AI System Power"
        >
          <Power className="w-8 h-8" />
          <div className={`absolute -inset-2 rounded-full border border-cyan-400/20 transition-transform duration-1000 ${isActive ? 'scale-125 opacity-0' : 'scale-100 opacity-100'}`} />
        </button>

        <button
          onClick={toggleCamera}
          disabled={!isActive}
          className={`p-4 rounded-full border transition-all duration-300 ${isCameraOn ? 'border-cyan-400 text-cyan-400 bg-cyan-400/10' : 'border-white/10 text-white/20'} disabled:opacity-20 cursor-pointer`}
          title="Toggle Visual Camera Feed"
        >
          {isCameraOn ? <Camera className="w-6 h-6" /> : <CameraOff className="w-6 h-6" />}
        </button>

        {/* Audio Output & Voice System Hub Button */}
        <div className="relative">
          <button
            onClick={() => {
              setShowAudioMenu(!showAudioMenu);
              refreshAudioDevices();
            }}
            className={`p-4 rounded-full border transition-all duration-300 ${showAudioMenu || activeBluetoothSpeakerLabel ? 'border-cyan-400 text-cyan-400 bg-cyan-400/10 shadow-[0_0_15px_rgba(0,240,255,0.2)]' : 'border-white/10 text-white/30 hover:text-white/80'} cursor-pointer relative`}
            title="Speaker & Voice Routing System"
          >
            {activeBluetoothSpeakerLabel ? (
              <Bluetooth className="w-6 h-6 animate-pulse text-cyan-400" />
            ) : (
              <Volume2 className="w-6 h-6" />
            )}
            {activeBluetoothSpeakerLabel && (
              <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-cyan-400 animate-ping" />
            )}
          </button>

          {/* Audio & Single Voice Control Center Modal */}
          <AnimatePresence>
            {showAudioMenu && (
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.95 }}
                className="absolute bottom-16 -right-12 sm:right-auto sm:left-1/2 sm:-translate-x-1/2 w-80 sm:w-96 p-4 rounded-2xl bg-black/95 border border-cyan-400/50 backdrop-blur-2xl shadow-[0_0_30px_rgba(0,240,255,0.2)] z-50 flex flex-col gap-3 font-mono text-xs"
              >
                {/* Header */}
                <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
                  <span className="text-[11px] font-bold tracking-wider text-cyan-400 uppercase flex items-center gap-2">
                    <Volume2 size={16} className="text-cyan-400" /> SPEAKER & SINGLE VOICE SYSTEM
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={refreshAudioDevices}
                      className="p-1 rounded text-white/50 hover:text-cyan-400 cursor-pointer transition-colors"
                      title="Rescan Audio Devices"
                    >
                      <RefreshCw size={14} className={isScanningDevices ? 'animate-spin text-cyan-400' : ''} />
                    </button>
                    <button 
                      onClick={() => setShowAudioMenu(false)} 
                      className="text-white/40 hover:text-white cursor-pointer text-sm"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* Status Badge Summary */}
                <div className="p-2.5 rounded-xl border bg-cyan-950/40 border-cyan-400/40 text-cyan-300 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 truncate">
                    <Volume2 size={14} className="text-cyan-400 shrink-0" />
                    <div className="truncate">
                      <div className="text-[8px] uppercase tracking-wider text-white/40">Speaker Output</div>
                      <div className="text-[10px] font-semibold truncate">{activeBluetoothSpeakerLabel ? activeBluetoothSpeakerLabel : 'System Default Speaker'}</div>
                    </div>
                  </div>
                  <span className="text-[9px] bg-cyan-400/20 text-cyan-300 px-2 py-0.5 rounded font-bold uppercase shrink-0">
                    {selectedVoice}
                  </span>
                </div>

                {/* Live Microphone Volume Meter (when user asks questions) */}
                <div className="p-2.5 rounded-xl bg-black/60 border border-white/10 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-[9px] uppercase tracking-wider">
                    <span className="text-white/60 flex items-center gap-1">
                      <Activity size={11} className="text-cyan-400" /> Mic Input Voice Level
                    </span>
                    <span className={isListening ? 'text-yellow-400 font-bold animate-pulse' : 'text-white/30'}>
                      {isListening ? 'QUESTION DETECTED' : 'READY'}
                    </span>
                  </div>
                  <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden relative">
                    <motion.div 
                      className="h-full bg-gradient-to-r from-cyan-500 to-yellow-400 rounded-full"
                      animate={{ width: `${micVolumeLevel}%` }}
                      transition={{ duration: 0.1 }}
                    />
                  </div>
                </div>

                {/* Speaker Output Selection Section */}
                <div className="flex flex-col gap-1 max-h-32 overflow-y-auto pr-1">
                  <div className="text-[9px] uppercase tracking-wider text-cyan-400 font-bold mt-1 mb-0.5 flex items-center justify-between">
                    <span>1. SELECT SPEAKER (VOICE OUTPUT):</span>
                    {outputDevices.length > 0 && <span className="text-white/30 font-normal">{outputDevices.length} Detected</span>}
                  </div>
                  {outputDevices.length === 0 ? (
                    <div className="text-[10px] text-white/40 italic p-1">Default browser output enabled</div>
                  ) : (
                    outputDevices.map((device, idx) => {
                      const isBt = /bluetooth|wireless|headset|hands-free|airpods|buds|speaker|a2dp/i.test(device.label);
                      const isSelected = selectedSpeakerId === device.deviceId;
                      return (
                        <button
                          key={device.deviceId || idx}
                          onClick={() => applyAudioOutputDevice(device.deviceId)}
                          className={`w-full text-left p-2 rounded-lg border transition-all flex items-center justify-between gap-2 cursor-pointer ${isSelected ? 'border-cyan-400 bg-cyan-400/10 text-cyan-300' : 'border-white/5 hover:bg-white/5 text-white/70'}`}
                        >
                          <div className="flex items-center gap-2 truncate">
                            {isBt ? <Bluetooth size={12} className="text-cyan-400 shrink-0 animate-pulse" /> : <Volume2 size={12} className="text-white/40 shrink-0" />}
                            <span className="truncate text-[10px]">
                              {device.label || `Audio Device ${idx + 1}`}
                            </span>
                          </div>
                          {isSelected && <Check size={13} className="text-cyan-400 shrink-0" />}
                        </button>
                      );
                    })
                  )}
                </div>

                {/* AI Single Voice Selection Section */}
                <div className="flex flex-col gap-1 max-h-32 overflow-y-auto pr-1">
                  <div className="text-[9px] uppercase tracking-wider text-cyan-400 font-bold mt-1 mb-0.5 flex items-center justify-between">
                    <span>2. AI SINGLE VOICE PERSONA:</span>
                    <span className="text-white/30 font-normal">Active: {selectedVoice}</span>
                  </div>
                  {[
                    { id: 'Fenrir', label: 'Fenrir (Male - Deep & Clear)' },
                    { id: 'Aoede', label: 'Aoede (Female - Warm & Natural)' },
                    { id: 'Puck', label: 'Puck (Male - Energetic)' },
                    { id: 'Kore', label: 'Kore (Female - Calm & Crisp)' },
                    { id: 'Charon', label: 'Charon (Deep Male)' },
                  ].map((v) => {
                    const isSelected = selectedVoice === v.id;
                    return (
                      <button
                        key={v.id}
                        onClick={() => {
                          setSelectedVoice(v.id);
                          setDeviceToastMsg(`Single Voice Set: ${v.id}`);
                          setTimeout(() => setDeviceToastMsg(null), 3000);
                        }}
                        className={`w-full text-left p-2 rounded-lg border transition-all flex items-center justify-between gap-2 cursor-pointer ${isSelected ? 'border-cyan-400 bg-cyan-400/10 text-cyan-300' : 'border-white/5 hover:bg-white/5 text-white/70'}`}
                      >
                        <div className="flex items-center gap-2 truncate">
                          <Sparkles size={12} className={isSelected ? "text-cyan-400 shrink-0" : "text-white/30 shrink-0"} />
                          <span className="truncate text-[10px] font-semibold">{v.label}</span>
                        </div>
                        {isSelected && <Check size={13} className="text-cyan-400 shrink-0" />}
                      </button>
                    );
                  })}
                </div>

                {/* Test Audio Signal Button */}
                <button
                  onClick={testAudioSignal}
                  className="mt-1 w-full py-2 rounded-xl border border-cyan-400/40 bg-cyan-400/10 hover:bg-cyan-400/20 text-cyan-300 font-semibold text-[11px] tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer shadow-sm"
                >
                  <Volume2 size={13} /> TEST SPEAKER CHIME
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="mt-8 text-[10px] tracking-[0.3em] uppercase opacity-20 font-mono">
        Jezy AI Neural Interface v4.2
      </div>
    </div>
  );
}
