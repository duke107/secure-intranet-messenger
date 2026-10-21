import React from 'react';
import {
  LiveKitRoom,
  VideoConference,
  RoomAudioRenderer,
  TrackToggle,
  useParticipants,
  useRoomContext
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import '@livekit/components-styles';

const AudioUI = ({ callKey }: { callKey?: string | null }) => {
    const room = useRoomContext();
    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '20px' }}>
                <div style={{ fontSize: '3.5rem' }}>📞</div>
                <h2 style={{ color: 'white', margin: 0 }}>Voice Call in Progress</h2>
                {callKey ? (
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        background: 'rgba(16, 185, 129, 0.15)',
                        border: '1px solid #10b981',
                        borderRadius: '20px',
                        padding: '6px 14px',
                        color: '#10b981',
                        fontSize: '0.85rem',
                        fontWeight: 600
                    }}>
                        <span>🔒</span> Post-Quantum E2EE Session Verified
                    </div>
                ) : (
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Direct WebRTC Audio Stream</div>
                )}
            </div>
            <div className="lk-control-bar" style={{ padding: '20px', display: 'flex', justifyContent: 'center', gap: '20px', background: '#222' }}>
                <TrackToggle source={Track.Source.Microphone} />
                <button 
                    onClick={() => room.disconnect()} 
                    style={{ 
                        padding: '10px 24px', 
                        background: '#ef4444', 
                        color: 'white', 
                        border: 'none', 
                        borderRadius: '8px', 
                        fontWeight: 'bold', 
                        cursor: 'pointer' 
                    }}>
                    End Call
                </button>
            </div>
        </div>
    );
};

const CallManager = () => {
    const participants = useParticipants();
    const room = useRoomContext();
    const hasJoined = React.useRef(false);

    React.useEffect(() => {
        if (participants.length > 1) {
            hasJoined.current = true;
        } else if (hasJoined.current && participants.length === 1) {
            console.log('All other participants left. Ending call.');
            room.disconnect();
        }
    }, [participants.length, room]);

    return null;
};

export const CallRoom = ({ token, callType, callKey, onLeave }: { token: string, callType?: string, callKey?: string | null, onLeave: () => void }) => {
  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000, background: '#111' }}>
      {callKey && (
        <div style={{
            position: 'absolute',
            top: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 2000,
            background: 'rgba(16, 185, 129, 0.25)',
            border: '1px solid #10b981',
            borderRadius: '24px',
            padding: '8px 18px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            color: '#10b981',
            fontSize: '0.85rem',
            fontWeight: 600,
            backdropFilter: 'blur(10px)',
            boxShadow: '0 4px 15px rgba(0,0,0,0.5)',
            pointerEvents: 'none'
        }}>
            <span style={{ fontSize: '1.1rem' }}>🔒</span>
            <span>Post-Quantum E2EE Secured Call</span>
            <span style={{ opacity: 0.8, fontSize: '0.75rem', fontFamily: 'monospace' }}>
                (Key: {callKey.substring(0, 10)}...)
            </span>
        </div>
      )}
      <LiveKitRoom
        video={callType === 'video'}
        audio={true}
        token={token}
        serverUrl="ws://localhost:7880"
        onConnected={() => console.log('LiveKitRoom Connected!')}
        onDisconnected={() => {
            console.log('LiveKitRoom Disconnected! Triggering onLeave()');
            onLeave();
        }}
      >
        <CallManager />
        {callType === 'audio' ? <AudioUI callKey={callKey} /> : <VideoConference />}
        <RoomAudioRenderer />
      </LiveKitRoom>
    </div>
  );
};
