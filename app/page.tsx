'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Clock3, Pause, Play, RotateCcw, ShieldCheck, Sparkles, Trophy, Volume2, VolumeX } from 'lucide-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

const ROUND_SECONDS = 30;
const SPAWN_INTERVAL_MS = 760;
const PLAYER_STEP = 25;
const STORAGE_KEY = 'thirty-second-dodge:v1';

type GameStatus = 'idle' | 'running' | 'paused' | 'won' | 'lost';
type Obstacle = { x: number; y: number; radius: number; speed: number; drift: number; rotation: number; spin: number };
type SavedStats = { version: 1; bestSurvival: number; clears: number; muted: boolean; reduceMotion: boolean };

const DEFAULT_STATS: SavedStats = { version: 1, bestSurvival: 0, clears: 0, muted: false, reduceMotion: false };

function isSavedStats(value: unknown): value is SavedStats {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SavedStats>;
  return item.version === 1 && typeof item.bestSurvival === 'number' && Number.isFinite(item.bestSurvival) && item.bestSurvival >= 0 && item.bestSurvival <= ROUND_SECONDS && typeof item.clears === 'number' && Number.isInteger(item.clears) && item.clears >= 0 && typeof item.muted === 'boolean' && typeof item.reduceMotion === 'boolean';
}

function formatTime(seconds: number) {
  return seconds.toFixed(1).padStart(4, '0');
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number | null>(null);
  const statusRef = useRef<GameStatus>('idle');
  const elapsedRef = useRef(0);
  const lastFrameRef = useRef(0);
  const spawnElapsedRef = useRef(0);
  const viewportRef = useRef({ width: 800, height: 450, dpr: 1 });
  const playerRef = useRef({ x: 400, y: 382 });
  const obstaclesRef = useRef<Obstacle[]>([]);
  const particlesRef = useRef<Array<{ x: number; y: number; vx: number; vy: number; life: number; color: string }>>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const mutedRef = useRef(false);
  const reduceMotionRef = useRef(false);

  const [status, setStatus] = useState<GameStatus>('idle');
  const [timeLeft, setTimeLeft] = useState(ROUND_SECONDS);
  const [bestSurvival, setBestSurvival] = useState(0);
  const [lastSurvival, setLastSurvival] = useState(0);
  const [clears, setClears] = useState(0);
  const [muted, setMuted] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [hitFlash, setHitFlash] = useState(false);
  const [pauseReason, setPauseReason] = useState<'manual' | 'focus'>('manual');

  const updateStatus = useCallback((next: GameStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const ensureAudio = useCallback(() => {
    if (audioContextRef.current) return audioContextRef.current;
    const context = new window.AudioContext();
    const gain = context.createGain();
    gain.gain.value = mutedRef.current ? 0 : 0.2;
    gain.connect(context.destination);
    audioContextRef.current = context;
    masterGainRef.current = gain;
    return context;
  }, []);

  const tone = useCallback((frequency: number, duration: number, type: OscillatorType = 'sine', delay = 0) => {
    if (mutedRef.current) return;
    const context = ensureAudio();
    if (context.state === 'suspended') void context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + delay;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.7, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(masterGainRef.current!);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }, [ensureAudio]);

  const playSuccess = useCallback(() => {
    tone(523, 0.2); tone(659, 0.2, 'sine', 0.12); tone(784, 0.35, 'sine', 0.24);
  }, [tone]);
  const playFailure = useCallback(() => {
    tone(130, 0.16, 'sawtooth'); tone(82, 0.38, 'triangle', 0.13);
  }, [tone]);

  const resetPositions = useCallback(() => {
    const { width, height } = viewportRef.current;
    playerRef.current = { x: width / 2, y: height - 58 };
    obstaclesRef.current = [];
    particlesRef.current = [];
    elapsedRef.current = 0;
    spawnElapsedRef.current = 0;
    lastFrameRef.current = performance.now();
    setTimeLeft(ROUND_SECONDS);
    setHitFlash(false);
  }, []);

  const startGame = useCallback(() => {
    ensureAudio();
    resetPositions();
    updateStatus('running');
  }, [ensureAudio, resetPositions, updateStatus]);

  const togglePause = useCallback(() => {
    if (statusRef.current === 'running') {
      setPauseReason('manual'); updateStatus('paused');
    } else if (statusRef.current === 'paused') {
      lastFrameRef.current = performance.now(); updateStatus('running');
    }
  }, [updateStatus]);

  const finishGame = useCallback((result: 'won' | 'lost') => {
    if (statusRef.current !== 'running') return;
    const survived = result === 'won' ? ROUND_SECONDS : Math.min(elapsedRef.current, ROUND_SECONDS);
    setLastSurvival(survived);
    setBestSurvival((current) => Math.max(current, survived));
    if (result === 'won') {
      setClears((current) => current + 1);
      if (!reduceMotionRef.current) {
        const { width, height } = viewportRef.current;
        const colors = ['#68f5c4', '#ffd166', '#77a8ff', '#fb7185'];
        particlesRef.current = Array.from({ length: 54 }, (_, index) => ({ x: width / 2, y: height / 2, vx: (Math.random() - 0.5) * 290, vy: -80 - Math.random() * 230, life: 0.8 + Math.random() * 0.7, color: colors[index % colors.length] }));
      }
      playSuccess();
    } else {
      setHitFlash(true);
      window.setTimeout(() => setHitFlash(false), reduceMotionRef.current ? 120 : 440);
      playFailure();
    }
    updateStatus(result);
  }, [playFailure, playSuccess, updateStatus]);

  useEffect(() => {
    let saved = DEFAULT_STATS;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (!isSavedStats(parsed)) throw new Error('Invalid saved game data');
        saved = parsed;
      }
    } catch {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_STATS));
    }
    const timer = window.setTimeout(() => {
      setBestSurvival(saved.bestSurvival); setClears(saved.clears); setMuted(saved.muted); setReduceMotion(saved.reduceMotion);
      mutedRef.current = saved.muted; reduceMotionRef.current = saved.reduceMotion;
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const next: SavedStats = { version: 1, bestSurvival, clears, muted, reduceMotion };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // The game remains playable when browser storage is unavailable.
    }
  }, [bestSurvival, clears, hydrated, muted, reduceMotion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
      viewportRef.current = { width: rect.width, height: rect.height, dpr };
      const margin = 22;
      playerRef.current.x = Math.min(Math.max(playerRef.current.x, margin), rect.width - margin);
      playerRef.current.y = Math.min(Math.max(playerRef.current.y, margin), rect.height - margin);
      if (statusRef.current === 'idle') playerRef.current = { x: rect.width / 2, y: rect.height - 58 };
    };
    resize();
    let resizeFrame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        resize();
      });
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    };
  }, []);

  useEffect(() => {
    const movePlayer = (event: KeyboardEvent) => {
      const directions: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
      if (event.code === 'Space' && (statusRef.current === 'running' || statusRef.current === 'paused')) {
        event.preventDefault(); togglePause(); return;
      }
      const direction = directions[event.key];
      if (!direction || statusRef.current !== 'running') return;
      event.preventDefault();
      const { width, height } = viewportRef.current;
      const margin = 18;
      playerRef.current.x = Math.min(width - margin, Math.max(margin, playerRef.current.x + direction[0] * PLAYER_STEP));
      playerRef.current.y = Math.min(height - margin, Math.max(margin, playerRef.current.y + direction[1] * PLAYER_STEP));
    };
    window.addEventListener('keydown', movePlayer);
    return () => window.removeEventListener('keydown', movePlayer);
  }, [togglePause]);

  useEffect(() => {
    const pauseForFocus = () => {
      if (statusRef.current === 'running') { setPauseReason('focus'); updateStatus('paused'); }
    };
    const onVisibility = () => { if (document.hidden) pauseForFocus(); };
    window.addEventListener('blur', pauseForFocus); document.addEventListener('visibilitychange', onVisibility);
    return () => { window.removeEventListener('blur', pauseForFocus); document.removeEventListener('visibilitychange', onVisibility); };
  }, [updateStatus]);

  useEffect(() => {
    const draw = (now: number) => {
      const canvas = canvasRef.current;
      const context = canvas?.getContext('2d');
      if (!canvas || !context) return;
      const { width, height, dpr } = viewportRef.current;
      const dt = Math.min((now - lastFrameRef.current) / 1000, 0.05);
      lastFrameRef.current = now;
      if (statusRef.current === 'running') {
        elapsedRef.current += dt; spawnElapsedRef.current += dt * 1000;
        if (spawnElapsedRef.current >= SPAWN_INTERVAL_MS) {
          spawnElapsedRef.current -= SPAWN_INTERVAL_MS;
          const radius = 13 + Math.random() * 13;
          obstaclesRef.current.push({ x: radius + Math.random() * Math.max(width - radius * 2, 1), y: -radius - 8, radius, speed: 135 + Math.random() * 78, drift: (Math.random() - 0.5) * 36, rotation: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 2.2 });
        }
        const player = playerRef.current;
        for (const obstacle of obstaclesRef.current) {
          obstacle.y += obstacle.speed * dt; obstacle.x += obstacle.drift * dt; obstacle.rotation += obstacle.spin * dt;
          if (Math.hypot(obstacle.x - player.x, obstacle.y - player.y) < obstacle.radius + 11) { finishGame('lost'); break; }
        }
        obstaclesRef.current = obstaclesRef.current.filter((obstacle) => obstacle.y < height + obstacle.radius + 20);
        setTimeLeft(Math.max(0, ROUND_SECONDS - elapsedRef.current));
        if (elapsedRef.current >= ROUND_SECONDS) finishGame('won');
      }
      if (particlesRef.current.length) {
        particlesRef.current.forEach((particle) => { particle.x += particle.vx * dt; particle.y += particle.vy * dt; particle.vy += 360 * dt; particle.life -= dt; });
        particlesRef.current = particlesRef.current.filter((particle) => particle.life > 0);
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height);
      const gradient = context.createLinearGradient(0, 0, 0, height); gradient.addColorStop(0, '#071522'); gradient.addColorStop(1, '#06101a'); context.fillStyle = gradient; context.fillRect(0, 0, width, height);
      context.strokeStyle = 'rgba(104, 245, 196, 0.08)'; context.lineWidth = 1;
      for (let x = 0; x < width; x += 44) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke(); }
      for (let y = 0; y < height; y += 44) { context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); }
      obstaclesRef.current.forEach((obstacle) => {
        context.save(); context.translate(obstacle.x, obstacle.y); context.rotate(obstacle.rotation); context.shadowColor = 'rgba(251, 113, 133, 0.65)'; context.shadowBlur = 16; context.fillStyle = '#fb7185'; context.strokeStyle = '#fecdd3'; context.lineWidth = 2; context.beginPath();
        for (let index = 0; index < 7; index += 1) { const angle = (Math.PI * 2 * index) / 7; const variance = index % 2 ? 0.78 : 1; const x = Math.cos(angle) * obstacle.radius * variance; const y = Math.sin(angle) * obstacle.radius * variance; if (index === 0) context.moveTo(x, y); else context.lineTo(x, y); }
        context.closePath(); context.fill(); context.stroke(); context.restore();
      });
      const player = playerRef.current;
      context.save(); context.translate(player.x, player.y); context.shadowColor = '#68f5c4'; context.shadowBlur = 22; context.fillStyle = '#68f5c4'; context.beginPath(); context.moveTo(0, -15); context.lineTo(12, 11); context.lineTo(0, 7); context.lineTo(-12, 11); context.closePath(); context.fill(); context.fillStyle = '#eafff8'; context.beginPath(); context.arc(0, 0, 3.2, 0, Math.PI * 2); context.fill(); context.restore();
      particlesRef.current.forEach((particle) => { context.globalAlpha = Math.max(particle.life, 0); context.fillStyle = particle.color; context.fillRect(particle.x, particle.y, 6, 10); }); context.globalAlpha = 1;
      frameRef.current = requestAnimationFrame(draw);
    };
    lastFrameRef.current = performance.now(); frameRef.current = requestAnimationFrame(draw);
    return () => { if (frameRef.current !== null) cancelAnimationFrame(frameRef.current); };
  }, [finishGame]);

  const handleMute = (checked: boolean) => { mutedRef.current = checked; setMuted(checked); if (masterGainRef.current) masterGainRef.current.gain.value = checked ? 0 : 0.2; };
  const handleReduceMotion = (checked: boolean) => { reduceMotionRef.current = checked; setReduceMotion(checked); if (checked) particlesRef.current = []; };
  const resetRecords = () => { setBestSurvival(0); setClears(0); };

  useEffect(() => {
    type ModelContext = {
      registerTool: (tool: {
        name: string;
        title: string;
        description: string;
        inputSchema: object;
        annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
        execute: (input: unknown) => unknown;
      }, options?: { signal?: AbortSignal }) => void | Promise<void>;
    };
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const registration = context.registerTool({
      name: 'configure_game_preferences',
      title: '게임 환경 설정',
      description: '30초 피하기 게임의 음소거와 움직임 감소 설정을 변경합니다.',
      inputSchema: {
        type: 'object',
        properties: { muted: { type: 'boolean' }, reduceMotion: { type: 'boolean' } },
        anyOf: [{ required: ['muted'] }, { required: ['reduceMotion'] }],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        if (!input || typeof input !== 'object') throw new Error('설정 객체가 필요합니다.');
        const preferences = input as { muted?: unknown; reduceMotion?: unknown };
        if (preferences.muted === undefined && preferences.reduceMotion === undefined) throw new Error('변경할 설정이 없습니다.');
        if (preferences.muted !== undefined && typeof preferences.muted !== 'boolean') throw new Error('muted는 boolean이어야 합니다.');
        if (preferences.reduceMotion !== undefined && typeof preferences.reduceMotion !== 'boolean') throw new Error('reduceMotion은 boolean이어야 합니다.');
        if (typeof preferences.muted === 'boolean') {
          mutedRef.current = preferences.muted;
          setMuted(preferences.muted);
          if (masterGainRef.current) masterGainRef.current.gain.value = preferences.muted ? 0 : 0.2;
        }
        if (typeof preferences.reduceMotion === 'boolean') {
          reduceMotionRef.current = preferences.reduceMotion;
          setReduceMotion(preferences.reduceMotion);
          if (preferences.reduceMotion) particlesRef.current = [];
        }
        return { muted: mutedRef.current, reduceMotion: reduceMotionRef.current };
      },
    }, { signal: lifecycle.signal });
    void Promise.resolve(registration).catch(() => lifecycle.abort());
    return () => lifecycle.abort();
  }, []);

  const statusCopy = {
    idle: { label: '준비', title: '30초를 버틸 준비가 됐나요?', detail: '방향키로 이동해 떨어지는 물체를 피하세요.' },
    running: { label: '진행 중', title: '시야를 넓게 보세요', detail: '한 번의 방향키 입력이 한 번의 이동으로 반영됩니다.' },
    paused: { label: '일시정지', title: pauseReason === 'focus' ? '창을 벗어나 게임을 멈췄어요' : '잠시 멈췄어요', detail: '준비되면 이어서 플레이하세요.' },
    won: { label: '성공', title: '30초 생존 성공!', detail: '기록을 저장했습니다. 새 판에 도전해보세요.' },
    lost: { label: '실패', title: '물체와 충돌했어요', detail: `${formatTime(lastSurvival)}초를 버텼습니다. 다시 도전해보세요.` },
  }[status];

  return (
    <main className={`game-shell ${hitFlash ? 'is-hit' : ''} ${reduceMotion ? 'reduce-motion' : ''}`}>
      <header className="topbar">
        <div className="brand" aria-label="30초 피하기"><span className="brand-mark"><ShieldCheck aria-hidden="true" /></span><div><p>THIRTY SECOND</p><h1>DODGE</h1></div></div>
        <div className="top-controls" aria-label="환경 설정">
          <div className="switch-control">{muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}<span>음소거</span><Switch checked={muted} onCheckedChange={handleMute} aria-label="음소거" /></div>
          <div className="switch-control"><Sparkles aria-hidden="true" /><span>움직임 감소</span><Switch checked={reduceMotion} onCheckedChange={handleReduceMotion} aria-label="움직임 감소" /></div>
        </div>
      </header>
      <section className="game-layout" aria-label="게임 영역">
        <div className="game-column">
          <div className="game-hud">
            <div><span className={`status-dot status-${status}`} /><span>{statusCopy.label}</span></div>
            <div className="timer" aria-live="polite"><Clock3 aria-hidden="true" /><strong>{formatTime(timeLeft)}</strong><span>초</span></div>
            <div className="difficulty-chip">생성 간격 {SPAWN_INTERVAL_MS}ms</div>
          </div>
          <div className="arena-wrap">
            <canvas ref={canvasRef} className="arena" aria-label="방향키로 플레이어를 움직여 장애물을 피하는 게임 화면" />
            {status !== 'running' && <div className="game-overlay">
              <span className="overlay-kicker">{statusCopy.label}</span><h2>{statusCopy.title}</h2><p>{statusCopy.detail}</p>
              {status === 'paused' ? <Button size="lg" onClick={togglePause} className="primary-action"><Play data-icon="inline-start" /> 계속하기</Button> : <Button size="lg" onClick={startGame} className="primary-action">{status === 'idle' ? <Play data-icon="inline-start" /> : <RotateCcw data-icon="inline-start" />}{status === 'idle' ? '게임 시작' : '다시 시작'}</Button>}
            </div>}
          </div>
          <div className="control-strip">
            <div className="key-guide" aria-label="방향키 조작 안내"><span className="key empty" aria-hidden="true" /><kbd><ArrowUp aria-label="위쪽 방향키" /></kbd><span className="key empty" aria-hidden="true" /><kbd><ArrowLeft aria-label="왼쪽 방향키" /></kbd><kbd><ArrowDown aria-label="아래쪽 방향키" /></kbd><kbd><ArrowRight aria-label="오른쪽 방향키" /></kbd></div>
            <p><strong>방향키</strong>로 이동 · <strong>Space</strong>로 일시정지</p>
            <Button variant="outline" onClick={togglePause} disabled={status !== 'running' && status !== 'paused'} className="pause-button">{status === 'paused' ? <Play data-icon="inline-start" /> : <Pause data-icon="inline-start" />}{status === 'paused' ? '계속' : '일시정지'}</Button>
          </div>
        </div>
        <aside className="side-panel" aria-label="게임 정보">
          <section className="mission-card"><p className="eyebrow">MISSION 01</p><h2>30초 동안<br />충돌하지 마세요.</h2><div className="survival-track" aria-hidden="true"><span style={{ width: `${Math.min(((ROUND_SECONDS - timeLeft) / ROUND_SECONDS) * 100, 100)}%` }} /></div><p className="mission-note">위에서 떨어지는 붉은 물체에 닿으면 즉시 실패합니다.</p></section>
          <section className="records-card">
            <div className="card-title-row"><p className="eyebrow">내 기록</p><Trophy aria-hidden="true" /></div>
            <dl><div><dt>최장 생존</dt><dd>{formatTime(bestSurvival)}<small>초</small></dd></div><div><dt>누적 성공</dt><dd>{clears}<small>회</small></dd></div></dl>
            <AlertDialog><AlertDialogTrigger render={<Button variant="ghost" size="sm" className="reset-records" />}>기록 초기화</AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>저장된 기록을 초기화할까요?</AlertDialogTitle><AlertDialogDescription>최장 생존 시간과 누적 성공 횟수가 0으로 돌아갑니다. 설정은 유지됩니다.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>취소</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={resetRecords}>초기화</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
          </section>
          <section className="rule-card"><p className="eyebrow">게임 규칙</p><ol><li><span>01</span> 게임 시작을 누릅니다.</li><li><span>02</span> 방향키로 물체를 피합니다.</li><li><span>03</span> 30초 생존하면 성공입니다.</li></ol></section>
        </aside>
      </section>
    </main>
  );
}
