import React, { useState, useEffect, useRef } from "react";

// --- webkitAudioContext를 포함하는 Window 타입 정의 ---
type WindowWithWebKitAudioContext = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

export default function DelayedAuditoryFeedback() {
  const [isActive, setIsActive] = useState(false);
  const [delayTime, setDelayTime] = useState(200); // 실제 오디오 처리용 상태
  const [displayDelay, setDisplayDelay] = useState<string>(
    delayTime.toString()
  );
  const [volume, setVolume] = useState(0.8); // 기본 볼륨 80%
  const [micPermission, setMicPermission] = useState<
    "granted" | "denied" | null
  >(null);
  const [audioLevel, setAudioLevel] = useState(0); // 시각화를 위한 오디오 레벨

  // 오디오 처리를 위한 ref
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const delayNodeRef = useRef<DelayNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // 브라우저 지원 확인
  const isWebAudioSupported =
    typeof window !== "undefined" &&
    // --- 정의된 타입 사용 ---
    (window.AudioContext ||
      (window as WindowWithWebKitAudioContext).webkitAudioContext);

  // 초기화 및 정리
  useEffect(() => {
    return () => {
      console.log("컴포넌트 언마운트 : 오디오 정리");
      stopAudio();
    };
  }, []);

  const stopAudio = () => {
    // 애니메이션 프레임 취소
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    // 오디오 자원 정리
    if (streamRef.current) {
      streamRef.current
        .getTracks()
        .forEach((track: MediaStreamTrack) => track.stop());
      streamRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current
        .close()
        // --- 수정 : error 타입을 unknown으로 변경하고 타입 확인 추가 ---
        .catch((error: unknown) => {
          if (error instanceof Error) {
            console.error("오디오 컨텍스트 종료 에러:", error.message);
          } else {
            console.error("알 수 없는 오디오 컨텍스트 종료 에러:", error);
          }
        });
      audioContextRef.current = null;
    }

    sourceNodeRef.current = null;
    delayNodeRef.current = null;
    gainNodeRef.current = null;
    analyserRef.current = null;

    console.log("오디오 중지됨");
    setIsActive(false);
    setAudioLevel(0);
  };

  const startAudio = async () => {
    console.log("startAudio 호출됨"); // 로그 추가
    try {
      if (!isWebAudioSupported) {
        throw new Error("이 브라우저는 Web Audio API를 지원하지 않습니다");
      }
      // 오디오 컨텍스트 상태 확인 및 처리
      if (
        audioContextRef.current &&
        audioContextRef.current.state === "running"
      ) {
        console.log("오디오가 이미 실행 중입니다.");
        // 이미 실행 중이면 추가 작업 없이 종료 (혹은 필요시 재시작 로직)
        return;
      }

      // 기존 오디오 컨텍스트가 suspended 상태이면 재개 시도
      if (
        audioContextRef.current &&
        audioContextRef.current.state === "suspended"
      ) {
        console.log("기존 AudioContext 재개 시도...");
        await audioContextRef.current.resume();
        console.log(
          "AudioContext 재개 완료, 상태:",
          audioContextRef.current.state
        );
        // Linter 오류 수정: resume 후에도 suspended 상태인지 확인
        if (audioContextRef.current.state === "suspended") {
          console.warn(
            "AudioContext 재개 후에도 suspended 상태임. 컨텍스트를 재생성합니다."
          );
          // 재개 실패 시 컨텍스트 닫고 새로 생성하도록 유도
          await audioContextRef.current.close();
          audioContextRef.current = null;
        }
      }

      // 오디오 컨텍스트 생성 (기존에 없거나 closed 상태일 때)
      if (!audioContextRef.current) {
        console.log("새 AudioContext 생성 중...");
        // --- 수정: latencyHint 옵션 추가 ---
        const contextOptions: AudioContextOptions = { latencyHint: "playback" };
        // --- 수정: 정의된 타입 사용 ---
        const context = new (window.AudioContext ||
          (window as WindowWithWebKitAudioContext).webkitAudioContext)(
          contextOptions
        );
        audioContextRef.current = context;
        context.onstatechange = () => {
          // 상태 변경 로깅 (running, suspended, closed)
          console.log("AudioContext 상태 변경:", context.state);
          // 만약 외부 요인(예: 기기 연결 해제)으로 closed되면 UI 업데이트 필요
          if (context.state === "closed" && isActive) {
            console.warn("AudioContext가 예기치 않게 닫혔습니다.");
            stopAudio(); // 상태 동기화
          }
        };
        console.log(
          "새 AudioContext 생성됨, 상태:",
          context.state,
          "옵션:",
          contextOptions
        );
      }

      const audioContext = audioContextRef.current;

      // 마이크 스트림 가져오기 (매번 새로 요청)
      console.log("마이크 스트림 요청 중...");
      // 기존 스트림 중지 (필수)
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        console.log("기존 마이크 스트림 중지됨");
      }
      // --- 수정: getUserMedia 제약 조건 추가 (AGC, Noise Suppression 비활성화 시도) ---
      const constraints: MediaStreamConstraints = {
        audio: {
          autoGainControl: false,
          noiseSuppression: false,
          echoCancellation: false, // 에코 제거도 비활성화 시도
        },
      };
      console.log("getUserMedia 제약 조건:", constraints);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      setMicPermission("granted");
      console.log("마이크 스트림 획득 완료");

      // 오디오 노드 정리 및 재생성
      console.log("오디오 노드 정리 및 재생성 중...");
      // 기존 노드 연결 해제 (안전하게)
      sourceNodeRef.current?.disconnect();
      analyserRef.current?.disconnect();
      delayNodeRef.current?.disconnect();
      gainNodeRef.current?.disconnect();

      // 새 노드 생성
      const sourceNode = audioContext.createMediaStreamSource(stream);
      sourceNodeRef.current = sourceNode;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      // analyser.smoothingTimeConstant = 0.1; // 시각화 부드럽게 (선택 사항)
      analyserRef.current = analyser;

      // --- 수정: 최대 지연 시간 조정 ---
      const delayNode = audioContext.createDelay(1.5); // 최대 1.5초 (1500ms)로 변경
      delayNode.delayTime.setValueAtTime(
        delayTime / 1000,
        audioContext.currentTime
      );
      delayNodeRef.current = delayNode;

      const gainNode = audioContext.createGain();
      // 현재 volume 값으로 초기 설정
      gainNode.gain.setValueAtTime(volume, audioContext.currentTime);
      gainNodeRef.current = gainNode;
      console.log("오디오 노드 생성 완료 (DelayNode maxDelayTime: 1.5s)");

      // 오디오 그래프 연결
      console.log("오디오 그래프 연결 중...");
      // --- 수정: 재생 경로와 분석 경로 분리 ---
      // 경로 1: 재생 (소리 -> 딜레이 -> 게인 -> 출력)
      sourceNode.connect(delayNode);
      delayNode.connect(gainNode);
      gainNode.connect(audioContext.destination);
      // 경로 2: 시각화 (소리 -> 분석기) - 분석기는 출력이 없어도 됨
      sourceNode.connect(analyser);
      console.log(
        "오디오 그래프 연결 완료: [재생] source -> delay -> gain -> destination, [시각화] source -> analyser"
      );

      // 컨텍스트 상태 최종 확인 및 필요시 재개 (자동 재생 정책 대응)
      if (audioContext.state === "suspended") {
        console.log("AudioContext가 suspended 상태이므로 최종 재개 시도...");
        await audioContext.resume();
        console.log("AudioContext 최종 재개 완료 후 상태:", audioContext.state);
      }

      // 모든 설정 완료 후 활성 상태로 변경
      setIsActive(true);
      console.log("isActive 상태 true로 설정");
    } catch (error) {
      console.error("오디오 시작 오류 상세:", error); // 상세 오류 로깅

      const err = error as Error;
      // 오류 유형에 따른 사용자 피드백
      if (
        err.name === "NotAllowedError" ||
        err.name === "PermissionDeniedError"
      ) {
        setMicPermission("denied");
        alert(
          "마이크 접근 권한이 거부되었습니다. 브라우저 설정을 확인하거나 페이지를 새로고침 후 다시 시도해주세요."
        );
      } else if (
        err.name === "NotFoundError" ||
        err.name === "DevicesNotFoundError"
      ) {
        setMicPermission(null); // 권한 상태 알 수 없음
        alert(
          "사용 가능한 마이크 장치를 찾을 수 없습니다. 마이크가 연결되어 있는지 확인해주세요."
        );
      } else if (
        err.name === "NotReadableError" ||
        err.name === "TrackStartError"
      ) {
        alert(
          "마이크를 읽는 중 오류가 발생했습니다. 다른 프로그램에서 마이크를 사용 중인지 확인하거나, 마이크 연결 상태를 확인해주세요."
        );
      } else if (
        err.name === "OverconstrainedError" ||
        err.name === "ConstraintNotSatisfiedError"
      ) {
        alert("요청된 오디오 설정을 만족하는 마이크를 찾을 수 없습니다.");
      } else if (err.name === "TypeError") {
        alert(
          "Web Audio API 관련 초기화 오류가 발생했습니다. 브라우저 호환성을 확인해주세요."
        );
      } else {
        alert(`오디오 시작 중 예기치 않은 오류 발생: ${err.message}`);
      }

      stopAudio(); // 오류 발생 시 오디오 관련 자원 정리
    }
  };

  const toggleAudio = () => {
    console.log("toggleAudio 호출됨, 현재 isActive:", isActive); // 로그 추가
    if (isActive) {
      stopAudio();
    } else {
      // startAudio 함수 내에서 상태 확인 및 resume 로직을 포함하므로 바로 호출
      startAudio();
    }
  };

  // --- 추가 : isActive 상태 변경에 따른 애니메이션 프레임 관리 ---
  useEffect(() => {
    // Define the loop function inside the effect
    const loop = () => {
      // 분석기 노드가 없거나 활성 상태가 아니면 중단
      if (!analyserRef.current || !isActive) {
        // 루프가 중단될 때 프레임 참조를 null로 설정하는 것이 좋습니다.
        // cleanup 함수가 이를 처리하지만, 여기서도 명시적으로 할 수 있습니다.
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
        return;
      }

      const analyser = analyserRef.current; // 현재 ref 값 캡처
      const bufferLength = analyser.fftSize;
      const dataArray = new Uint8Array(bufferLength);
      try {
        analyser.getByteTimeDomainData(dataArray);
      } catch (e) {
        console.error("getByteTimeDomainData 오류:", e);
        // 오류 시 루프 중단
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
        return;
      }

      let sumOfSquares = 0;
      for (let i = 0; i < bufferLength; i++) {
        const normSample = dataArray[i] / 128.0 - 1.0;
        sumOfSquares += normSample * normSample;
      }
      const rms = Math.sqrt(sumOfSquares / bufferLength);
      const visualLevel = Math.min(rms * 5, 1);

      // 함수형 업데이트 사용
      setAudioLevel((prevAudioLevel) => {
        if (
          Math.abs(prevAudioLevel - visualLevel) > 0.01 ||
          (visualLevel === 0 && prevAudioLevel !== 0)
        ) {
          return visualLevel;
        }
        return prevAudioLevel; // 변경 없음
      });

      // 다음 프레임 요청
      animationFrameRef.current = requestAnimationFrame(loop);
    };

    if (isActive) {
      // isActive가 true일 때 루프 시작
      if (analyserRef.current) {
        console.log("useEffect[isActive=true]: Animation loop 시작");
        // 이전 프레임이 남아있을 수 있으므로 취소 후 시작 (안전 장치)
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
        }
        animationFrameRef.current = requestAnimationFrame(loop);
      } else {
        console.error(
          "useEffect[isActive=true]: 루프 시작 실패 - analyserRef가 없습니다."
        );
      }
    } else {
      // isActive가 false일 때 루프 중지 (cleanup에서도 처리됨) 및 오디오 레벨 리셋
      console.log(
        "useEffect[isActive=false]: Animation loop 중지 및 레벨 리셋"
      );
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      setAudioLevel(0); // 비활성화 시 레벨을 0으로 설정
    }

    // Cleanup 함수: 컴포넌트 언마운트 시 또는 isActive 변경 전에 호출됨
    return () => {
      console.log("useEffect[isActive] cleanup: 루프 정리");
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [isActive]); // 이제 isActive에만 의존합니다.

  // --- 추가: delayTime 변경 시 displayDelay 동기화 ---
  // 슬라이더, 프리셋 등으로 delayTime이 변경되면 입력 필드에도 반영
  useEffect(() => {
    // 현재 입력 필드 값과 실제 delayTime이 다를 경우에만 동기화
    // (사용자가 입력 중인 중간 상태는 덮어쓰지 않도록 주의 필요할 수 있으나,
    // 현재 로직에서는 delayTime 변경 시 항상 덮어쓰는 것이 의도된 동작일 수 있음)
    if (displayDelay !== delayTime.toString()) {
      // console.log(`Syncing displayDelay: ${delayTime}`); // 필요시 디버깅
      setDisplayDelay(delayTime.toString());
    }
  }, [delayTime, displayDelay]); // delayTime 또는 displayDelay가 변경될 때마다 실행

  // 지연 시간 변경 시 업데이트
  useEffect(() => {
    // gainNode가 존재하고, 오디오 컨텍스트가 실행 중일 때만 업데이트
    if (delayNodeRef.current && audioContextRef.current?.state === "running") {
      // --- 로그 추가 ---
      console.log(`useEffect[delayTime]: ${delayTime}ms 로 변경 시도`);
      const targetTime = audioContextRef.current.currentTime + 0.05; // 약간의 지연을 두고 적용
      try {
        // 현재 값에서 목표 값으로 부드럽게 변경 (0.05초 동안)
        delayNodeRef.current.delayTime.linearRampToValueAtTime(
          delayTime / 1000,
          targetTime
        );
      } catch (e) {
        console.error("delayTime 설정 오류:", e);
        // 오류 발생 시 직접 설정 시도 (Fallback)
        try {
          delayNodeRef.current.delayTime.setValueAtTime(
            delayTime / 1000,
            audioContextRef.current.currentTime
          );
        } catch (e2) {
          console.error("delayTime 직접 설정 오류:", e2);
        }
      }
    }
  }, [delayTime, displayDelay]); // delayTime 또는 displayDelay 변경 시 실행 (lint 수정)

  // 볼륨 변경 시 업데이트
  useEffect(() => {
    // gainNode가 존재하고, 오디오 컨텍스트가 실행 중일 때만 업데이트
    if (gainNodeRef.current && audioContextRef.current?.state === "running") {
      // --- 로그 추가 ---
      console.log(
        `useEffect[volume]: ${Math.round(volume * 100)}% 로 변경 시도`
      );
      const targetTime = audioContextRef.current.currentTime + 0.05; // 약간의 지연을 두고 적용
      try {
        // 현재 값에서 목표 값으로 부드럽게 변경 (0.05초 동안)
        gainNodeRef.current.gain.linearRampToValueAtTime(volume, targetTime);
      } catch (e) {
        console.error("gain 설정 오류:", e);
        // 오류 발생 시 직접 설정 시도 (Fallback)
        try {
          gainNodeRef.current.gain.setValueAtTime(
            volume,
            audioContextRef.current.currentTime
          );
        } catch (e2) {
          console.error("gain 직접 설정 오류:", e2);
        }
      }
    }
  }, [volume]); // volume 변경 시 실행

  // 오디오 레벨 기반 시각화 높이 계산
  const visualizerHeight = `${Math.max(4, audioLevel * 100)}%`;

  // 자주 사용되는 지연 시간 프리셋
  const delayPresets = [
    { label: "짧게", value: 50 },
    { label: "보통", value: 150 },
    { label: "길게", value: 300 }, // 최대값 300으로 변경
  ];

  // --- 추가 : 입력값 처리 함수 ---
  const handleDelayInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // 입력 필드 표시는 항상 업데이트 (빈 문자열 허용)
    setDisplayDelay(value);

    // 빈 문자열이 아니면 숫자 변환 및 유효성 검사 시도
    if (value !== "") {
      const numValue = parseInt(value, 10);
      // 유효한 숫자이고 범위 내이며, 현재 delayTime과 다를 때만 업데이트
      if (!isNaN(numValue) && numValue >= 10 && numValue <= 300) {
        // 최대값 300으로 변경
        if (delayTime !== numValue) {
          // console.log(`Input change: Setting delayTime to ${numValue}`); // 디버깅 로그
          setDelayTime(numValue);
        }
      }
    }
  };

  // --- 추가: 입력 필드 포커스 아웃 시 유효성 검사/복원 ---
  const handleDelayInputBlur = () => {
    const numValue = parseInt(displayDelay, 10);
    // 유효하지 않거나 범위를 벗어난 경우, 현재 유효한 delayTime 값으로 복원
    if (isNaN(numValue) || numValue < 10 || numValue > 300) {
      // 최대값 300으로 변경
      // console.log(`Input blur: Invalid input '${displayDelay}', restoring to ${delayTime}`); // 디버깅 로그
      setDisplayDelay(delayTime.toString());
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-indigo-50 via-purple-50 to-pink-50 p-6">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl overflow-hidden">
        {/* 헤더 */}
        <div className="bg-gradient-to-r from-indigo-500 to-purple-600 px-6 py-4">
          <h1 className="text-xl font-bold text-white">지연 청각 피드백</h1>
          <p className="text-indigo-100 text-sm">
            조절 가능한 지연으로 목소리 듣기
          </p>
        </div>

        <div className="p-6 space-y-6">
          {/* 시각화 도구 */}
          <div className="h-20 bg-gray-100 rounded-lg flex items-end p-2 overflow-hidden relative">
            <div
              className="w-full bg-gradient-to-t from-indigo-500 to-purple-500 rounded-sm transition-all duration-100 ease-out absolute bottom-0 left-0"
              style={{ height: visualizerHeight }}
              aria-hidden="true"
            />
          </div>

          {/* 프리셋 버튼 */}
          <div className="grid grid-cols-3 gap-2">
            {delayPresets.map((preset) => (
              <button
                key={preset.value}
                onClick={() => {
                  // --- 수정: setDelayTime만 호출 (useEffect가 displayDelay 업데이트) ---
                  setDelayTime(preset.value);
                }}
                className={`py-2 text-xs font-medium rounded transition-colors duration-150 ${
                  delayTime === preset.value
                    ? "bg-indigo-100 text-indigo-700 border border-indigo-300 ring-1 ring-indigo-300"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200 border border-transparent"
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {/* 지연 시간 제어 */}
          <div className="space-y-2">
            <div className="flex justify-between items-center space-x-2">
              <label
                htmlFor="delay-input"
                className="text-sm font-medium text-gray-700 flex-shrink-0"
              >
                지연 시간
              </label>
              <div className="flex items-center space-x-1 bg-gray-100 rounded border border-gray-200 px-2 py-1">
                <input
                  id="delay-input"
                  type="number"
                  min="10" // 브라우저 기본 유효성 검사용
                  max="300" // 최대값 300으로 변경
                  step="10"
                  // --- 수정: value, onChange, onBlur ---
                  value={displayDelay}
                  onChange={handleDelayInputChange}
                  onBlur={handleDelayInputBlur} // 포커스 잃었을 때 유효성 검사/복원
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  className="w-16 text-right text-sm font-medium text-indigo-600 bg-transparent focus:outline-none appearance-none"
                  style={{
                    MozAppearance: "textfield",
                    appearance: "textfield",
                  }}
                />
                <span className="text-sm font-medium text-gray-600">ms</span>
              </div>
            </div>
            {/* 슬라이더 */}
            <input
              id="delay-slider"
              type="range"
              min="10"
              max="300" // 최대값 300으로 변경
              step="10"
              value={delayTime} // 슬라이더는 실제 delayTime에 바인딩
              onChange={(e) => {
                // --- 수정: setDelayTime만 호출 (useEffect가 displayDelay 업데이트) ---
                setDelayTime(parseInt(e.target.value));
              }}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <div className="flex justify-between text-xs text-gray-500">
              <span>10ms</span>
              <span>300ms</span> {/* 최대값 레이블 변경 */}
            </div>
          </div>

          {/* 볼륨 제어 */}
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <label
                htmlFor="volume-slider"
                className="text-sm font-medium text-gray-700"
              >
                볼륨
              </label>
              <span className="text-sm font-medium text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
                {Math.round(volume * 100)}%
              </span>
            </div>
            <input
              id="volume-slider"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <div className="flex justify-between text-xs text-gray-500">
              <span>0%</span>
              <span>100%</span>
            </div>
          </div>

          {/* 상태 및 제어 */}
          <div className="pt-2">
            <button
              onClick={toggleAudio}
              disabled={!isWebAudioSupported}
              className={`w-full py-3 px-4 rounded-lg text-white font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                isActive
                  ? "bg-red-500 hover:bg-red-600 focus:ring-red-500"
                  : "bg-indigo-600 hover:bg-indigo-700 focus:ring-indigo-500"
              } ${!isWebAudioSupported ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              {isActive ? "중지" : "시작"}
            </button>

            {/* 상태 표시기 */}
            <div className="flex items-center justify-center mt-3 space-x-2">
              <div
                className={`w-3 h-3 rounded-full transition-colors duration-300 ${
                  isActive ? "bg-green-500 animate-pulse" : "bg-gray-300"
                }`}
              ></div>
              <span className="text-sm font-medium text-gray-700">
                {isActive ? "활성" : "비활성"}
              </span>
            </div>
          </div>

          {/* 사용 방법 */}
          <div className="text-xs text-gray-600 border-t border-gray-200 pt-4">
            <p className="mb-1 font-bold">사용 방법</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>헤드폰을 연결하세요 (스피커 사용 시 하울링 발생 가능)</li>
              <li>차음이 잘 되는 헤드폰(마이크 분리형 권장)을 사용하고, 헤드폰 볼륨은 최대로 설정하세요.</li>
              <li>'시작' 버튼을 클릭하고 마이크 접근을 허용하세요</li>
              <li>지연 시간과 볼륨을 조절하세요 (슬라이더 또는 직접 입력)</li>
              <li>말을 하면 설정된 지연 시간 후 자신의 목소리가 들립니다</li>
            </ol>
          </div>

          {/* 브라우저 지원 경고 */}
          {!isWebAudioSupported && (
            <div
              className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-700 text-xs"
              role="alert"
            >
              <p className="font-medium">브라우저 호환성 문제</p>
              <p className="mt-1">
                현재 사용 중인 브라우저는 Web Audio API를 지원하지 않아 이
                기능을 사용할 수 없습니다. 최신 버전의 Chrome, Firefox, Safari,
                Edge 브라우저를 사용해 보세요.
              </p>
            </div>
          )}

          {/* 마이크 권한 거부 경고 */}
          {micPermission === "denied" && (
            <div
              className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs"
              role="alert"
            >
              <p className="font-medium">마이크 접근 거부됨</p>
              <p className="mt-1">
                마이크 접근 권한이 필요합니다. 브라우저의 주소창 옆 마이크
                아이콘 또는 사이트 설정에서 권한을 허용해주세요.
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 text-xs text-gray-500 text-center max-w-md">
        지연 청각 피드백(DAF)은 자신의 목소리를 약간의 시간 지연을 두고 듣게
        하는 기술입니다. 이는 말더듬 치료나 특정 신경학적 상태 연구 등 다양한
        분야에서 활용됩니다.
      </div>
    </div>
  );
}
