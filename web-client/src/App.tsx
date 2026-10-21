import { useState, useEffect, useRef } from 'react';
import { Send, Check, CheckCheck, User, MessageCircle, MessageSquarePlus, LogOut, Users, Settings, Phone, Video, Mic, PhoneOff, Trash2, Pause, Play } from 'lucide-react';
import { CallRoom } from './CallRoom';
import DOMPurify from 'dompurify';
import ReactQuill from 'react-quill-new';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import { 
    initCryptoDB, 
    generateAndUploadKeysIfNeeded, 
    clearCryptoDB, 
    fetchPreKeys, 
    encryptMessage, 
    decryptMessage,
    saveLocalMessage,
    getAllLocalMessages,
    updateLocalMessageStatus,
    markLocalMessageDeleted,
    clearLocalChatMessages,
    encryptFileBuffer,
    decryptFileBuffer
} from './crypto';
import 'react-quill-new/dist/quill.snow.css';
import './index.css';

interface Message {
  id: string; 
  senderId: string;
  recipientId: string | null;
  groupId: string | null;
  payload: string;
  status: 'UPLOADING' | 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  timestamp: string;
  progress?: number; // Added for UPLOADING state
  is_deleted?: boolean;
  is_forwarded?: boolean;
}

interface Group {
    id: string;
    name: string;
    role: string;
    is_announcement_only: boolean;
}

function App() {
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [token, setToken] = useState<string | null>(localStorage.getItem('im_token'));
  
  const [isConnected, setIsConnected] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  
  const [activeChat, setActiveChat] = useState<string | null>(null);
  const [activeChatIsGroup, setActiveChatIsGroup] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'chats'|'calls'>('chats');
  const [callHistory, setCallHistory] = useState<any[]>([]);

  const [newChatTarget, setNewChatTarget] = useState('');
  const [inputText, setInputText] = useState('');
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [forwardingPayload, setForwardingPayload] = useState<string | null>(null);
  const [forwardSearch, setForwardSearch] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [blockedUsers, setBlockedUsers] = useState<string[]>([]);
  
  const [showSettings, setShowSettings] = useState(false);
  const [profilePicUrl, setProfilePicUrl] = useState('');
  const [rank, setRank] = useState('');
  const [activeChatPresence, setActiveChatPresence] = useState('offline');
  const [activeChatRank, setActiveChatRank] = useState('');
  const [activeChatAvatar, setActiveChatAvatar] = useState('');
  
  // Group UI State
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupIsAnnouncement, setNewGroupIsAnnouncement] = useState(false);
  const [showManageGroup, setShowManageGroup] = useState(false);
  const [groupMembers, setGroupMembers] = useState<{user_id: string, role: string}[]>([]);
  const [newMemberId, setNewMemberId] = useState('');
  
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});

  // WebRTC / Calls State
  const [incomingCall, setIncomingCall] = useState<any>(null);
  const [activeCallRoom, setActiveCallRoom] = useState<string | null>(null);
  const [activeCallType, setActiveCallType] = useState<string>('audio');
  const [livekitToken, setLivekitToken] = useState<string | null>(null);
  const [callKey, setCallKey] = useState<string | null>(null);
  const [outboundCall, setOutboundCall] = useState<string | null>(null);

  // Voice Note State
  const [isRecording, setIsRecording] = useState(false);
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingCancelRef = useRef(false);

  const ws = useRef<WebSocket | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Refs for resolving stale closures in WebSocket listener
  const outboundCallRef = useRef(outboundCall);
  useEffect(() => { outboundCallRef.current = outboundCall; }, [outboundCall]);
  
  const activeCallRoomRef = useRef(activeCallRoom);
  useEffect(() => { activeCallRoomRef.current = activeCallRoom; }, [activeCallRoom]);

  const incomingCallRef = useRef(incomingCall);
  useEffect(() => { incomingCallRef.current = incomingCall; }, [incomingCall]);


  const activeChatRef = useRef(activeChat);
  useEffect(() => { activeChatRef.current = activeChat; }, [activeChat]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activeChat]);

  const playRingtone = async () => {
    if (!audioRef.current) {
        audioRef.current = new Audio('https://www.soundjay.com/phone/telephone-ring-04.mp3');
        audioRef.current.loop = true;
    }
    try {
        await audioRef.current.play();
    } catch (e) {
        console.warn('Autoplay blocked. Falling back to visual notification.');
        if (Notification.permission === 'granted') {
            new Notification('Incoming Call', { body: 'You have an incoming call on Nexus IM' });
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(p => {
                if (p === 'granted') new Notification('Incoming Call', { body: 'You have an incoming call on Nexus IM' });
            });
        }
        document.title = '📞 Incoming Call...';
    }
  };

  const stopRingtone = () => {
      if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.currentTime = 0;
      }
      document.title = 'Nexus IM';
  };

  const loadGroups = () => {
      fetch('http://localhost:8080/api/groups', {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) setGroups(data);
      })
      .catch(console.error);
  };

  // Heartbeat
  useEffect(() => {
    if (!isConnected || !ws.current) return;
    const interval = setInterval(() => {
        if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({ event_type: 'PING', timestamp: new Date().toISOString() }));
        }
    }, 30000);
    return () => clearInterval(interval);
  }, [isConnected]);



  // Settings sync
  useEffect(() => {
    if (showSettings && userId) {
        fetch(`http://localhost:8080/api/users/${userId}`, { headers: { 'Authorization': `Bearer ${token}` } })
        .then(r => r.json())
        .then(d => { setProfilePicUrl(d.profile_picture_url || ''); setRank(d.rank || ''); })
        .catch(console.error);
    }
  }, [showSettings, userId, token]);

  const saveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    fetch('http://localhost:8080/api/users/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ profile_picture_url: profilePicUrl, rank })
    }).then(() => setShowSettings(false));
  };

  // Presence fetcher
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    const fetchPresence = () => {
        if (activeChat && !activeChatIsGroup) {
            fetch(`http://localhost:8080/api/users/${activeChat}`, { headers: { 'Authorization': `Bearer ${token}` } })
            .then(r => r.json())
            .then(d => { setActiveChatPresence(d.presence); setActiveChatRank(d.rank || ''); setActiveChatAvatar(d.profile_picture_url || ''); })
            .catch(console.error);
        }
    };
    
    fetchPresence();
    if (activeChat && !activeChatIsGroup) {
        interval = setInterval(fetchPresence, 15000);
    }
    return () => clearInterval(interval);
  }, [activeChat, activeChatIsGroup, token]);

  const clearChat = () => {
    if (!activeChat) return;
    const targetChat = activeChat;
    const isGroup = activeChatIsGroup;
    fetch(`http://localhost:8080/api/chats/${targetChat}/clear`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
    }).then(res => {
        if (res.ok) {
            setMessages(prev => prev.filter(m => {
                if (isGroup) return m.groupId !== targetChat;
                return m.senderId !== targetChat && m.recipientId !== targetChat;
            }));
            setActiveChat(null);
            clearLocalChatMessages(targetChat, isGroup).catch(console.error);
        }
    });
  };

  // WebSocket Connection Management
  useEffect(() => {
    if (!token) return;

    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        setUserId(payload.userId);

        initCryptoDB(payload.userId);
        generateAndUploadKeysIfNeeded(token).catch(err => console.error("Key generation failed:", err));
    } catch(e) {
        handleLogout();
        return;
    }

    (async () => {
      try {
          const localMsgs = await getAllLocalMessages();
          const localMap = new Map(localMsgs.map(m => [m.id, m]));

          if (localMsgs.length > 0) {
              setMessages(localMsgs as any);
          }

          const res = await fetch('http://localhost:8080/api/messages', {
              headers: { 'Authorization': `Bearer ${token}` }
          });
          const data = await res.json();
          if (Array.isArray(data)) {
              const mapped = await Promise.all(data.map(async (row) => {
                  const cached = localMap.get(row.id);
                  if (cached) {
                      return {
                          ...cached,
                          status: row.status || cached.status,
                          is_deleted: row.is_deleted ?? cached.is_deleted,
                          is_forwarded: row.is_forwarded ?? cached.is_forwarded
                      };
                  }

                  let finalPayload = row.payload;
                  if (!row.groupId && row.senderId !== userId) {
                      try {
                          const parsed = JSON.parse(finalPayload);
                          if (parsed.ephemeral_x25519_pub) {
                              finalPayload = await decryptMessage(parsed);
                          }
                      } catch (e: any) {
                          if (finalPayload.includes('ciphertext')) {
                              finalPayload = `[🔒 Decryption Failed: ${e.message || String(e)}]`;
                          }
                      }
                  } else if (!row.groupId && row.senderId === userId) {
                       try {
                           const parsed = JSON.parse(finalPayload);
                           if (parsed.ephemeral_x25519_pub) finalPayload = "[🔒 Encrypted Message]";
                       } catch(e) {}
                  }
                  
                  const msgObj: any = {
                      id: row.id,
                      senderId: row.senderId,
                      recipientId: row.recipientId,
                      groupId: row.groupId,
                      payload: finalPayload,
                      status: row.status,
                      timestamp: row.timestamp,
                      is_deleted: row.is_deleted,
                      is_forwarded: row.is_forwarded
                  };

                  if (!finalPayload.startsWith('[🔒 Decryption Failed') && !finalPayload.startsWith('[🔒 Encrypted Message]')) {
                      saveLocalMessage(msgObj).catch(console.error);
                  }

                  return msgObj;
              }));
              setMessages(mapped);
          }
      } catch (err) {
          console.error("Message sync error:", err);
      }
    })();

    fetch('http://localhost:8080/api/blocked', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(data => {
      if (Array.isArray(data)) setBlockedUsers(data);
    })
    .catch(console.error);

    const fetchCallHistory = () => {
      fetch('http://localhost:8080/api/calls', {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) setCallHistory(data);
      })
      .catch(console.error);
    };
    fetchCallHistory();

    loadGroups();

    ws.current = new WebSocket(`ws://localhost:8080?token=${token}`);
    ws.current.onopen = () => setIsConnected(true);
    
    ws.current.onclose = (e) => {
        setIsConnected(false);
        if (e.code === 4001) handleLogout();
    };

    ws.current.onmessage = async (event) => {
      const frame = JSON.parse(event.data);

      if (frame.error) {
          console.error('Server error:', frame.error);
          return;
      }

      if (frame.event_type === 'ACK_SENT') {
        updateLocalMessageStatus(frame.client_message_id, 'SENT').catch(console.error);
        setMessages(prev => prev.map(msg => 
          msg.id === frame.client_message_id ? { ...msg, status: 'SENT' } : msg
        ));
      } 
      else if (frame.event_type === 'ACK_DELIVERED') {
        updateLocalMessageStatus(frame.client_message_id, 'DELIVERED').catch(console.error);
        setMessages(prev => prev.map(msg => 
          (msg.id === frame.client_message_id && msg.status !== 'READ') ? { ...msg, status: 'DELIVERED' } : msg
        ));
      }
      else if (frame.event_type === 'ACK_READ') {
        updateLocalMessageStatus(frame.client_message_id, 'READ').catch(console.error);
        setMessages(prev => prev.map(msg => 
          msg.id === frame.client_message_id ? { ...msg, status: 'READ' } : msg
        ));
      }
      else if (frame.event_type === 'MSG_DELETE') {
        markLocalMessageDeleted(frame.client_message_id).catch(console.error);
        setMessages(prev => prev.map(msg => 
          msg.id === frame.client_message_id ? { ...msg, is_deleted: true } : msg
        ));
      }
      else if (frame.event_type === 'GROUP_STATE_CHANGE') {
          // Reactively refresh local group data
          loadGroups();
          if (showManageGroup) {
              loadGroupMembers(frame.group_id);
          }
      }
      else if (frame.event_type === 'GROUP_DELETED') {
          setGroups(prev => prev.filter(g => g.id !== frame.group_id));
          setActiveChat(prev => prev === frame.group_id ? null : prev);
          setShowManageGroup(false);
      }
      else if (frame.event_type === 'CALL_OFFER') {
          console.log('Received CALL_OFFER:', frame);
          if (frame.sender_id === userId) {
              console.log('Ignoring own CALL_OFFER');
              return; 
          }
          if (Date.now() > frame.expires_at) {
              console.log('Ignored stale CALL_OFFER from Kafka/Redis:', frame.expires_at, 'Current Date:', Date.now());
              return;
          }

          if (frame.encrypted_call_key) {
              try {
                  console.log(`[🔓 CALL DECRYPT] Received Encrypted Call Offer. Decapsulating session key...`);
                  const payloadObj = typeof frame.encrypted_call_key === 'string' ? JSON.parse(frame.encrypted_call_key) : frame.encrypted_call_key;
                  const decryptedSessionKey = await decryptMessage(payloadObj);
                  console.log(`[✅ CALL KEY READY] Established Post-Quantum E2EE Call Session Key: ${decryptedSessionKey.substring(0, 16)}...`);
                  setCallKey(decryptedSessionKey);
              } catch (err) {
                  console.error("Failed to decrypt incoming call key:", err);
              }
          }

          console.log('Setting incoming call modal...');
          setIncomingCall(frame);
          playRingtone();
      }
      else if (frame.event_type === 'CALL_ANSWER') {
          if (outboundCallRef.current === frame.sender_id || (frame.group_id && outboundCallRef.current === frame.group_id)) {
              setOutboundCall(null);
              // Fetch token to join
              joinLiveKitRoom(frame.room_id);
          }
      }
      else if (frame.event_type === 'CALL_REJECTED') {
          fetchCallHistory();
          if (outboundCallRef.current === frame.sender_id) {
              setOutboundCall(null);
              setMessages(prev => [...prev, {
                  id: crypto.randomUUID(), senderId: 'SYSTEM', recipientId: userId, groupId: null, 
                  payload: `Call to ${frame.sender_id} was declined.`, status: 'READ', timestamp: new Date().toISOString()
              }]);
          }
      }
      else if (frame.event_type === 'CALL_ENDED') {
          fetchCallHistory();
          // If we are currently in this room, disconnect
          if (activeCallRoomRef.current === frame.room_id) {
              setLivekitToken(null);
              setActiveCallRoom(null);
              setMessages(prev => [...prev, {
                  id: crypto.randomUUID(), senderId: 'SYSTEM', recipientId: userId, groupId: null, 
                  payload: `Call ended.`, status: 'READ', timestamp: new Date().toISOString()
              }]);
          } else if (outboundCallRef.current === frame.sender_id) {
              // They rejected or ended the ring before we connected
              setOutboundCall(null);
          } else if (incomingCallRef.current?.room_id === frame.room_id) {
              // They canceled the call while ringing us
              setIncomingCall(null);
              stopRingtone();
          }
      }
      else if (frame.event_type === 'MSG_RECEIVE') {
        let finalPayload = frame.payload;
        if (!frame.group_id) {
            try {
                const parsedPayload = JSON.parse(frame.payload);
                if (parsedPayload.ephemeral_x25519_pub) {
                    finalPayload = await decryptMessage(parsedPayload);
                }
            } catch (err: any) {
                console.error("Decryption failed:", err);
                if (frame.payload.includes('ciphertext')) finalPayload = `[🔒 Decryption Failed: ${err.message || String(err)}]`;
            }
        }

        const newMsg: Message = {
          id: frame.client_message_id,
          senderId: frame.sender_id,
          recipientId: frame.group_id ? null : userId,
          groupId: frame.group_id || null,
          payload: finalPayload,
          status: 'DELIVERED', 
          timestamp: frame.timestamp,
          is_deleted: frame.is_deleted
        };

        if (!finalPayload.startsWith('[🔒 Decryption Failed')) {
            saveLocalMessage(newMsg).catch(console.error);
        }
        
        setMessages(prev => {
            if (prev.some(m => m.id === newMsg.id)) return prev;
            return [...prev, newMsg];
        });

        if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({
                event_type: 'ACK_DELIVERED',
                client_message_id: frame.client_message_id,
                timestamp: new Date().toISOString()
            }));
        }
      }
    };

    return () => { ws.current?.close(); };
  }, [token, userId]);

  useEffect(() => {
      const g = groups.find(g => g.id === activeChat);
      setActiveChatIsGroup(!!g);
  }, [activeChat, groups]);

  // Dispatch ACK_READ_BULK for any unread messages in the currently active chat
  useEffect(() => {
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
    
    // We can compute activeMessages inline here or rely on the global one, but since activeMessages
    // is defined later in the file, we'll compute the unread targets directly from the messages state.
    const unreadIds = messages
      .filter(m => {
          if (m.senderId === userId || m.status === 'READ') return false;
          if (activeChatIsGroup) return m.groupId === activeChat;
          return m.senderId === activeChat || m.recipientId === activeChat;
      })
      .map(m => m.id);

    if (unreadIds.length > 0) {
      ws.current.send(JSON.stringify({
        event_type: 'ACK_READ_BULK',
        client_message_ids: unreadIds,
        timestamp: new Date().toISOString()
      }));

      setMessages(prev => prev.map(m => 
        unreadIds.includes(m.id) ? { ...m, status: 'READ' } : m
      ));
    }
  }, [messages, activeChat, activeChatIsGroup, userId]);

  const loadGroupMembers = (groupId: string) => {
      fetch(`http://localhost:8080/api/groups/${groupId}/members`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      .then(res => res.json())
      .then(data => setGroupMembers(data))
      .catch(console.error);
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    const endpoint = isRegistering ? '/api/register' : '/api/login';
    
    try {
        const res = await fetch(`http://localhost:8080${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: userId, password })
        });
        const data = await res.json();
        if (!res.ok) return setErrorMsg(data.error || 'Authentication failed');

        localStorage.setItem('im_token', data.token);
        setToken(data.token);
        setRank(data.role || 'User'); // Use 'role' from response

        // Security Phase 2: Initialize DB and generate/upload keys
        initCryptoDB(data.userId);
        await generateAndUploadKeysIfNeeded(data.token);
    } catch (err) {
        setErrorMsg('Network error. Is Gateway running?');
    }
  };

  const handleLogout = () => {
      localStorage.removeItem('im_token');
      setToken(null);
      setMessages([]);
      setGroups([]);
      setActiveChat(null);
      ws.current?.close();
      // Keep device keys and local decrypted messages persistent on this device
  };

  const joinLiveKitRoom = async (roomName: string) => {
      console.log('Requesting LiveKit token for room:', roomName);
      try {
          const res = await fetch('http://localhost:8080/api/calls/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ roomName })
          });
          const data = await res.json();
          if (!res.ok) {
              console.error('Failed to get token, server returned:', data);
              return;
          }
          if (data.token) {
              console.log('Received LiveKit token, joining room...');
              setLivekitToken(data.token);
              setActiveCallRoom(roomName);
          } else {
              console.error('Token missing in response:', data);
          }
      } catch (err) {
          console.error('Failed to join LiveKit room (Network/CORS)', err);
      }
  };

  const startCall = async (type: 'audio' | 'video') => {
      if (!ws.current || !activeChat) return;
      
      const roomId = `room_${crypto.randomUUID()}`;
      setOutboundCall(activeChat);
      setActiveCallType(type);

      // Generate 256-bit ephemeral Call Session Key
      const ephemeralCallKey = Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map(b => b.toString(16).padStart(2, '0')).join('');
      setCallKey(ephemeralCallKey);

      let encryptedCallKeyPayload: any = null;
      if (!activeChatIsGroup) {
          try {
              console.log(`[🔒 CALL ENCRYPT] Exchanging Post-Quantum Ephemeral Call Key with ${activeChat}...`);
              const recipientKeys = await fetchPreKeys(activeChat, token!);
              const encKey = await encryptMessage(ephemeralCallKey, recipientKeys);
              encryptedCallKeyPayload = encKey;
              console.log(`[🛡️ CALL SECURED] Ephemeral Call Key sealed in Kyber/X25519 ciphertext!`);
          } catch (err) {
              console.error("Failed to encrypt call key:", err);
          }
      }

      ws.current.send(JSON.stringify({
          event_type: 'CALL_OFFER',
          client_message_id: crypto.randomUUID(),
          recipient_id: activeChatIsGroup ? null : activeChat,
          group_id: activeChatIsGroup ? activeChat : null,
          room_id: roomId,
          call_type: type,
          encrypted_call_key: encryptedCallKeyPayload,
          expires_at: Date.now() + 60000,
          timestamp: new Date().toISOString()
      }));
  };

  const acceptCall = () => {
      if (!incomingCall || !ws.current) return;
      stopRingtone();
      
      ws.current.send(JSON.stringify({
          event_type: 'CALL_ANSWER',
          client_message_id: crypto.randomUUID(),
          recipient_id: incomingCall.group_id ? null : incomingCall.sender_id,
          group_id: incomingCall.group_id || null,
          room_id: incomingCall.room_id,
          timestamp: new Date().toISOString()
      }));
      
      setActiveCallType(incomingCall.call_type);
      joinLiveKitRoom(incomingCall.room_id);
      setIncomingCall(null);
  };

  const rejectCall = () => {
      if (!incomingCall || !ws.current) return;
      stopRingtone();
      
      ws.current.send(JSON.stringify({
          event_type: 'CALL_REJECTED',
          client_message_id: crypto.randomUUID(),
          recipient_id: incomingCall.group_id ? null : incomingCall.sender_id,
          group_id: incomingCall.group_id || null,
          room_id: incomingCall.room_id,
          timestamp: new Date().toISOString()
      }));
      setIncomingCall(null);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length || !ws.current || !activeChat) return;
    
    // Clear the input
    e.target.value = '';

    for (let i = 0; i < files.length; i++) {
        uploadFile(files[i]);
    }
  };

  const startRecording = async () => {
      try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
          mediaRecorderRef.current = mediaRecorder;
          audioChunksRef.current = [];
          recordingCancelRef.current = false;
          setRecordingTime(0);
          setIsRecordingPaused(false);

          mediaRecorder.ondataavailable = (e) => {
              if (e.data.size > 0) audioChunksRef.current.push(e.data);
          };

          mediaRecorder.onstop = () => {
              stream.getTracks().forEach(t => t.stop());
              if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
              
              if (!recordingCancelRef.current) {
                  const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                  // Only send if it actually recorded something
                  if (blob.size > 0 && audioChunksRef.current.length > 0) {
                      const file = new File([blob], `VoiceNote_${Date.now()}.webm`, { type: 'audio/webm' });
                      uploadFile(file);
                  }
              }
              setIsRecording(false);
              setRecordingTime(0);
          };

          // Start emitting chunks every 100ms to ensure we get data
          mediaRecorder.start(100);
          setIsRecording(true);
          
          recordingTimerRef.current = setInterval(() => {
              setRecordingTime(prev => prev + 1);
          }, 1000);
      } catch (err) {
          console.error('Microphone access denied or error', err);
      }
  };

  const pauseRecording = () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.pause();
          setIsRecordingPaused(true);
          if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      }
  };

  const resumeRecording = () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'paused') {
          mediaRecorderRef.current.resume();
          setIsRecordingPaused(false);
          recordingTimerRef.current = setInterval(() => {
              setRecordingTime(prev => prev + 1);
          }, 1000);
      }
  };

  const cancelRecording = () => {
      recordingCancelRef.current = true;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
      }
  };

  const stopRecordingAndSend = () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
      }
  };

  const uploadFile = async (file: File) => {
        if (!ws.current || !activeChat) return;

        const messageId = crypto.randomUUID();
        const timestamp = new Date().toISOString();

        // 1. Inject Dummy "UPLOADING" Bubble
        const dummyMsg: Message = {
            id: messageId,
            senderId: userId,
            recipientId: activeChatIsGroup ? null : activeChat,
            groupId: activeChatIsGroup ? activeChat : null,
            payload: JSON.stringify({ text: `Encrypting & Uploading ${file.name}...` }),
            status: 'UPLOADING',
            progress: 0,
            timestamp
        };
        setMessages(prev => [...prev, dummyMsg]);

        try {
            // Read raw binary buffer and pre-encrypt with AES-256-GCM before it ever leaves the browser
            const rawBuffer = await file.arrayBuffer();
            const { encryptedBuffer, fileKeyHex, ivHex } = await encryptFileBuffer(rawBuffer);
            const encryptedBlob = new Blob([encryptedBuffer], { type: 'application/octet-stream' });

            // 2. Fetch Pre-Signed PUT URL
            const presignRes = await fetch(`http://localhost:8080/api/upload/presign?filename=${encodeURIComponent(file.name)}&contentType=application/octet-stream`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!presignRes.ok) throw new Error('Failed to fetch presigned URL');
            const { presignedUrl, objectKey } = await presignRes.json();

            // 3. Direct MinIO XHR Upload of Encrypted Ciphertext
            await new Promise<void>((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('PUT', presignedUrl, true);
                xhr.setRequestHeader('Content-Type', 'application/octet-stream');

                xhr.upload.onprogress = (event) => {
                    if (event.lengthComputable) {
                        const percentComplete = Math.round((event.loaded / event.total) * 100);
                        setMessages(prev => prev.map(m => m.id === messageId ? { ...m, progress: percentComplete } : m));
                    }
                };

                xhr.onload = () => {
                    if (xhr.status === 200 || xhr.status === 204) {
                        resolve();
                    } else {
                        reject(new Error(`Upload failed with status ${xhr.status}`));
                    }
                };
                xhr.onerror = () => reject(new Error('Upload failed'));
                xhr.send(encryptedBlob);
            });

            // 4. Construct Media Metadata containing File Encryption Key & IV
            const finalPayload = JSON.stringify({
                text: '',
                media: {
                    url: objectKey,
                    type: file.type,
                    size: file.size,
                    name: file.name,
                    fileKey: fileKeyHex,
                    iv: ivHex
                }
            });

            setMessages(prev => prev.map(m => m.id === messageId ? { ...m, status: 'PENDING', payload: finalPayload } : m));
            saveLocalMessage({
                id: messageId,
                senderId: userId,
                recipientId: activeChatIsGroup ? null : activeChat,
                groupId: activeChatIsGroup ? activeChat : null,
                payload: finalPayload,
                status: 'PENDING',
                timestamp
            }).catch(console.error);

            // 5. Encrypt Media Envelope using Hybrid Post-Quantum E2EE for the recipient
            let payloadToSend = finalPayload;
            if (!activeChatIsGroup) {
                try {
                    const recipientKeys = await fetchPreKeys(activeChat, token!);
                    const encrypted = await encryptMessage(finalPayload, recipientKeys);
                    payloadToSend = JSON.stringify({
                        ciphertext: encrypted.ciphertext,
                        iv: encrypted.iv,
                        ephemeral_x25519_pub: encrypted.ephemeral_x25519_pub,
                        mlkem_ciphertext: encrypted.mlkem_ciphertext,
                        used_one_time_key_id: encrypted.used_one_time_key_id
                    });
                } catch (err) {
                    console.error("Envelope encryption failed:", err);
                    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, status: 'FAILED' } : m));
                    return;
                }
            }

            const frame: any = {
                event_type: 'MSG_SEND',
                client_message_id: messageId,
                payload: payloadToSend,
                attachment_keys: [objectKey], // IDOR Gatekeeper Routing
                timestamp
            };
            if (activeChatIsGroup) {
                frame.group_id = activeChat;
            } else {
                frame.recipient_id = activeChat;
            }
            ws.current.send(JSON.stringify(frame));

            setTimeout(() => {
                setMessages(prev => prev.map(m => (m.id === messageId && m.status === 'PENDING') ? { ...m, status: 'FAILED' } : m));
            }, 5000);

        } catch (error) {
            console.error('File upload error:', error);
            setMessages(prev => prev.map(m => m.id === messageId ? { ...m, status: 'FAILED', payload: 'Upload failed' } : m));
        }
  };

  const sendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputText.trim() || inputText === '<p><br></p>' || !activeChat || !ws.current) return;

    let finalPayload = inputText;
    if (replyingTo) {
        finalPayload = `<div class="reply-block" style="border-left: 4px solid var(--accent); background: rgba(0,0,0,0.1); padding: 8px; margin-bottom: 8px; border-radius: 4px; font-size: 0.85rem;"><strong style="color: var(--accent);">${replyingTo.senderId}</strong><br/>${stripHtml(replyingTo.payload).substring(0, 100)}</div>${inputText}`;
    }

    const messageId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const newMsg: Message = {
      id: messageId,
      senderId: userId,
      recipientId: activeChatIsGroup ? null : activeChat,
      groupId: activeChatIsGroup ? activeChat : null,
      payload: finalPayload,
      status: 'PENDING',
      timestamp
    };

    setMessages(prev => [...prev, newMsg]);
    saveLocalMessage(newMsg).catch(console.error);
    setInputText('');
    setReplyingTo(null);
    setShowEmojiPicker(false);

    let payloadToSend = finalPayload;
    let cryptoMetadata = {};

    try {
        if (!activeChatIsGroup) {
            const recipientKeys = await fetchPreKeys(activeChat, token!);
            const encrypted = await encryptMessage(finalPayload, recipientKeys);
            payloadToSend = JSON.stringify({
                ciphertext: encrypted.ciphertext,
                iv: encrypted.iv,
                ephemeral_x25519_pub: encrypted.ephemeral_x25519_pub,
                mlkem_ciphertext: encrypted.mlkem_ciphertext,
                used_one_time_key_id: encrypted.used_one_time_key_id
            });
            cryptoMetadata = {}; 
        }
    } catch (err) {
        console.error("Encryption failed:", err);
        setMessages(prev => prev.map(m => m.id === messageId ? { ...m, status: 'FAILED' } : m));
        return;
    }

    const frame: any = {
      event_type: 'MSG_SEND',
      client_message_id: messageId,
      payload: payloadToSend,
      timestamp,
      ...cryptoMetadata
    };

    if (activeChatIsGroup) {
        frame.group_id = activeChat;
    } else {
        frame.recipient_id = activeChat;
    }

    ws.current.send(JSON.stringify(frame));
    
    setTimeout(() => {
        setMessages(prev => prev.map(m => (m.id === messageId && m.status === 'PENDING') ? { ...m, status: 'FAILED' } : m));
    }, 5000);

    setInputText('');
    setReplyingTo(null);
    setShowEmojiPicker(false);
  };

  const forwardMessage = (targetId: string, isTargetGroup: boolean) => {
    if (!forwardingPayload || !ws.current) return;
    const messageId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const newMsg: Message = {
      id: messageId,
      senderId: userId,
      recipientId: isTargetGroup ? null : targetId,
      groupId: isTargetGroup ? targetId : null,
      payload: forwardingPayload,
      status: 'PENDING',
      timestamp,
      is_forwarded: true
    };
    setMessages(prev => [...prev, newMsg]);
    saveLocalMessage(newMsg).catch(console.error);

    const frame: any = {
      event_type: 'MSG_SEND',
      client_message_id: messageId,
      payload: forwardingPayload,
      timestamp,
      is_forwarded: true
    };
    if (isTargetGroup) {
        frame.group_id = targetId;
    } else {
        frame.recipient_id = targetId;
    }
    ws.current.send(JSON.stringify(frame));
    
    setTimeout(() => {
        setMessages(prev => prev.map(m => (m.id === messageId && m.status === 'PENDING') ? { ...m, status: 'FAILED' } : m));
    }, 5000);

    setForwardingPayload(null);
    setForwardSearch('');
  };

  const handleStartNewChat = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = newChatTarget.trim();
    if (target && target !== userId) {
      try {
          const res = await fetch(`http://localhost:8080/api/users/${target}`, {
              headers: { 'Authorization': `Bearer ${token}` }
          });
          if (!res.ok) {
              setErrorMsg('User not found!');
              setTimeout(() => setErrorMsg(''), 3000);
              return;
          }
          setActiveChat(target);
          setNewChatTarget('');
      } catch (err) {
          console.error(err);
      }
    }
  };

  const createGroup = async (e: React.FormEvent) => {
      e.preventDefault();
      try {
          const res = await fetch('http://localhost:8080/api/groups', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ name: newGroupName, is_announcement_only: newGroupIsAnnouncement })
          });
          const data = await res.json();
          if (res.ok) {
              setGroups(prev => [...prev, data]);
              setActiveChat(data.id);
              setShowCreateGroup(false);
              setNewGroupName('');
              setNewGroupIsAnnouncement(false);
          }
      } catch (e) {
          console.error(e);
      }
  };

  const addGroupMember = async (e: React.FormEvent) => {
      e.preventDefault();
      try {
          const userRes = await fetch(`http://localhost:8080/api/users/${newMemberId}`, {
              headers: { 'Authorization': `Bearer ${token}` }
          });
          if (!userRes.ok) {
              setErrorMsg('User not found!');
              setTimeout(() => setErrorMsg(''), 3000);
              return;
          }

          const res = await fetch(`http://localhost:8080/api/groups/${activeChat}/members`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ targetUserId: newMemberId })
          });
          if (res.ok) {
              setNewMemberId('');
              loadGroupMembers(activeChat!);
          } else {
              const data = await res.json();
              setErrorMsg(data.error || 'Failed to add member');
              setTimeout(() => setErrorMsg(''), 3000);
          }
      } catch(e) { console.error(e); }
  };

  const promoteMember = async (targetUserId: string) => {
      try {
          const res = await fetch(`http://localhost:8080/api/groups/${activeChat}/role`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ targetUserId, role: 'admin' })
          });
          if (res.ok) loadGroupMembers(activeChat!);
      } catch(e) { console.error(e); }
  };

  const removeMember = async (targetUserId: string) => {
      try {
          const res = await fetch(`http://localhost:8080/api/groups/${activeChat}/members/${targetUserId}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${token}` }
          });
          if (res.ok) loadGroupMembers(activeChat!);
      } catch(e) { console.error(e); }
  };

  const toggleAnnouncement = async (currentVal: boolean) => {
      try {
          const res = await fetch(`http://localhost:8080/api/groups/${activeChat}/announcement`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ is_announcement_only: !currentVal })
          });
          if (res.ok) loadGroups();
      } catch(e) { console.error(e); }
  };

  const deleteGroup = async () => {
      if (!window.confirm('Are you sure you want to delete this group completely?')) return;
      try {
          const res = await fetch(`http://localhost:8080/api/groups/${activeChat}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${token}` }
          });
          if (res.ok) {
              setGroups(prev => prev.filter(g => g.id !== activeChat));
              setActiveChat(null);
              setShowManageGroup(false);
          }
      } catch(e) { console.error(e); }
  };

  const toggleBlock = async () => {
    if (!activeChat || !token || activeChatIsGroup) return;
    const isBlocked = blockedUsers.includes(activeChat);
    const endpoint = isBlocked ? '/api/unblock' : '/api/block';
    
    try {
      const res = await fetch(`http://localhost:8080${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ targetUserId: activeChat })
      });
      if (res.ok) {
        setBlockedUsers(prev => isBlocked ? prev.filter(id => id !== activeChat) : [...prev, activeChat]);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const quillModules = {
    toolbar: [
      ['bold', 'italic', 'underline', 'strike'],
      [{ 'color': [] }, { 'background': [] }],
      [{ 'size': ['small', false, 'large', 'huge'] }]
    ]
  };

  const renderTicks = (status: string) => {
    switch (status) {
      case 'PENDING': return <span className="tick">🕒</span>;
      case 'SENT': return <div className="ack-ticks"><Check size={14} className="tick active" /></div>;
      case 'DELIVERED': return <div className="ack-ticks"><CheckCheck size={14} className="tick active" /></div>;
      case 'READ': return <div className="ack-ticks"><CheckCheck size={14} className="tick read" /></div>;
      case 'FAILED': return <span className="tick" style={{ color: '#ef4444' }}>❌</span>;
      default: return null;
    }
  };

  const stripHtml = (html: string) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const replyBlocks = doc.querySelectorAll('.reply-block');
    replyBlocks.forEach(block => block.remove());
    return doc.body.textContent || "";
  };

  const stripReplyBlock = (html: string) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const replyBlocks = doc.querySelectorAll('.reply-block');
    replyBlocks.forEach(block => block.remove());
    return doc.body.innerHTML;
  };

  const conversationSet = new Set<string>();
  if (activeChat && !activeChatIsGroup) conversationSet.add(activeChat);
  messages.forEach(m => {
    if (m.groupId) return; // groups handled separately
    if (m.senderId !== userId) conversationSet.add(m.senderId);
    if (m.recipientId && m.recipientId !== userId) conversationSet.add(m.recipientId);
  });
  const dmConversations = Array.from(conversationSet);

  const allChats = [
    ...groups.map(g => ({ type: 'group', id: g.id, name: g.name, meta: g })),
    ...dmConversations.map(id => ({ type: 'dm', id, name: id, meta: null }))
  ];

  const chatsWithMeta = allChats.map(chat => {
    const chatMsgs = chat.type === 'group' 
        ? messages.filter(m => m.groupId === chat.id)
        : messages.filter(m => (m.senderId === chat.id && m.recipientId === userId) || (m.senderId === userId && m.recipientId === chat.id));
    
    const lastMsg = chatMsgs.length > 0 ? chatMsgs[chatMsgs.length - 1] : null;
    const unreadCount = chatMsgs.filter(m => m.senderId !== userId && m.status !== 'READ').length;

    return {
        ...chat,
        lastMsg,
        unreadCount,
        lastTimestamp: lastMsg ? new Date(lastMsg.timestamp).getTime() : 0
    };
  }).sort((a, b) => b.lastTimestamp - a.lastTimestamp);

  const activeMessages = messages.filter(m => 
    activeChatIsGroup 
      ? (m.groupId === activeChat)
      : ((m.senderId === activeChat && m.recipientId === userId) || (m.senderId === userId && m.recipientId === activeChat))
  );

  const activeGroupMeta = groups.find(g => g.id === activeChat);

  useEffect(() => {
      // Find objectKeys that we don't have presigned URLs for
      const keysToFetch: string[] = [];
      const mediaMetaMap: { [key: string]: { fileKey?: string; iv?: string; type?: string } } = {};

      activeMessages.forEach(msg => {
          if (msg.status === 'UPLOADING') return;
          try {
              const parsed = JSON.parse(msg.payload);
              if (parsed.media && parsed.media.url && !mediaUrls[parsed.media.url]) {
                  keysToFetch.push(parsed.media.url);
                  mediaMetaMap[parsed.media.url] = {
                      fileKey: parsed.media.fileKey,
                      iv: parsed.media.iv,
                      type: parsed.media.type
                  };
              }
          } catch (e) {
              // Not JSON
          }
      });

      if (keysToFetch.length > 0) {
          fetch('http://localhost:8080/api/media/presign-read', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ objectKeys: keysToFetch })
          })
          .then(res => res.json())
          .then(async data => {
              if (data.urls) {
                  const resolved: { [key: string]: string } = {};
                  await Promise.all(Object.entries(data.urls).map(async ([key, presignedUrl]) => {
                      const meta = mediaMetaMap[key];
                      if (meta && meta.fileKey && meta.iv) {
                          try {
                              console.log(`[🔒 FILE DOWNLOAD] Downloading encrypted attachment from MinIO (${key})...`);
                              const fileRes = await fetch(presignedUrl as string);
                              const encBuf = await fileRes.arrayBuffer();
                              const decBuf = await decryptFileBuffer(encBuf, meta.fileKey, meta.iv);
                              const blob = new Blob([decBuf], { type: meta.type || 'application/octet-stream' });
                              resolved[key] = URL.createObjectURL(blob);
                              console.log(`[🛡️ FILE DECRYPTED] Attachment ${key} decrypted into secure local Blob!`);
                          } catch (err) {
                              console.error(`Failed to decrypt attachment ${key}:`, err);
                              resolved[key] = presignedUrl as string;
                          }
                      } else {
                          // Unencrypted legacy file
                          resolved[key] = presignedUrl as string;
                      }
                  }));
                  setMediaUrls(prev => ({ ...prev, ...resolved }));
              }
          })
          .catch(console.error);
      }
  }, [activeMessages, mediaUrls, token]);

  const renderMessagePayload = (msg: Message) => {
      if (msg.status === 'UPLOADING') {
          try {
              const parsed = JSON.parse(msg.payload);
              return (
                  <div>
                      <div style={{ marginBottom: '5px' }}>{parsed.text}</div>
                      <div style={{ width: '100%', height: '8px', background: '#e2e8f0', borderRadius: '4px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${msg.progress || 0}%`, background: 'var(--accent)', transition: 'width 0.2s' }}></div>
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '2px', textAlign: 'right' }}>{msg.progress}%</div>
                  </div>
              );
          } catch (e) {
              return <div>Uploading...</div>;
          }
      }

      try {
          const parsed = JSON.parse(msg.payload);
          if (parsed.media) {
              const url = mediaUrls[parsed.media.url];
              return (
                  <div>
                      {parsed.text && <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(parsed.text) }} style={{ marginBottom: '8px' }} />}
                      {url ? (
                          parsed.media.type.startsWith('image/') ? (
                              <div>
                                  <img src={url} alt="Attachment" style={{ maxWidth: '100%', borderRadius: '8px', maxHeight: '300px' }} />
                                  {parsed.media.fileKey && (
                                      <div style={{ fontSize: '0.7rem', color: '#10b981', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                          <span>🔒</span> Post-Quantum E2EE Encrypted Media
                                      </div>
                                  )}
                              </div>
                          ) : parsed.media.type.startsWith('video/') ? (
                              <div>
                                  <video src={url} controls style={{ maxWidth: '100%', borderRadius: '8px', maxHeight: '300px' }} />
                                  {parsed.media.fileKey && (
                                      <div style={{ fontSize: '0.7rem', color: '#10b981', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                          <span>🔒</span> Post-Quantum E2EE Encrypted Video
                                      </div>
                                  )}
                              </div>
                          ) : parsed.media.type.startsWith('audio/') ? (
                              <div style={{ padding: '10px 14px', background: 'rgba(0,0,0,0.05)', borderRadius: '10px', minWidth: '240px' }}>
                                  <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text)', marginBottom: '6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>🎤 Voice Message</span>
                                      {parsed.media.fileKey && (
                                          <span style={{ fontSize: '0.7rem', color: '#10b981', display: 'flex', alignItems: 'center', gap: '3px' }}>🔒 E2EE</span>
                                      )}
                                  </div>
                                  <audio src={url} controls style={{ width: '100%', height: '36px' }} />
                              </div>
                          ) : (
                              <a href={url} download={parsed.media.name || 'document'} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '15px', padding: '12px 16px', background: 'rgba(0,0,0,0.05)', borderRadius: '10px', color: 'inherit', textDecoration: 'none', border: '1px solid rgba(0,0,0,0.1)' }}>
                                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', width: '40px', height: '40px', background: 'var(--accent)', color: 'white', borderRadius: '8px', fontSize: '1.2rem' }}>
                                      📄
                                  </div>
                                  <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                                      <span style={{ fontWeight: 600, fontSize: '0.9rem', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{parsed.media.name || 'Document'}</span>
                                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                          {parsed.media.size ? `${(parsed.media.size / 1024 / 1024).toFixed(2)} MB • ` : ''} {parsed.media.type.split('/')[1]?.toUpperCase() || 'FILE'}
                                          {parsed.media.fileKey && (
                                              <span style={{ color: '#10b981', fontWeight: 600 }}>• 🔒 E2EE Encrypted</span>
                                          )}
                                      </span>
                                  </div>
                              </a>
                          )
                      ) : (
                          <div style={{ padding: '20px', background: 'var(--bg-secondary)', borderRadius: '8px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                              Loading attachment...
                          </div>
                      )}
                  </div>
              );
          }
          // If JSON but no media, render text
          return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(parsed.text || "") }} />;
      } catch (e) {
          // Legacy string payload
          return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(msg.payload) }} />;
      }
  };

  let isInputDisabled = false;
  let placeholderText = "Type a message...";

  if (activeChatIsGroup && activeGroupMeta) {
      if (activeGroupMeta.is_announcement_only && activeGroupMeta.role !== 'admin') {
          isInputDisabled = true;
          placeholderText = "Only admins can send messages in this group.";
      }
  } else if (activeChat && blockedUsers.includes(activeChat)) {
      isInputDisabled = true;
      placeholderText = "Unblock this user to send a message...";
  }

  if (!token) {
    return (
      <div className="app-container" style={{ width: '100vw', height: '100vh', borderRadius: 0 }}>
        {/* Auth Screen same as before */}
        <div className="login-screen">
          <MessageCircle size={64} color="#818cf8" style={{ marginBottom: '1rem' }} />
          <h1>Nexus IM</h1>
          <p>{isRegistering ? 'Create a new sovereign identity' : 'Authenticate to your sovereign identity'}</p>
          
          <form onSubmit={handleAuth} className="input-group">
            <input type="text" className="input-field" placeholder="Username" value={userId} onChange={e => setUserId(e.target.value)} required />
            <input type="password" className="input-field" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required />
            {errorMsg && <div style={{ color: '#ef4444', fontSize: '0.9rem' }}>{errorMsg}</div>}
            <button type="submit" className="btn-primary"><User size={18} /> {isRegistering ? 'Register' : 'Login'}</button>
            <button type="button" style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', marginTop: '1rem' }} onClick={() => setIsRegistering(!isRegistering)}>
                {isRegistering ? 'Already have an account? Login' : 'Need an account? Register'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {errorMsg && (
          <div style={{ position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)', background: '#ef4444', color: 'white', padding: '10px 20px', borderRadius: '8px', zIndex: 9999, boxShadow: '0 4px 6px rgba(0,0,0,0.2)', fontWeight: 500 }}>
              {errorMsg}
          </div>
      )}
      {/* SIDEBAR */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ fontSize: '1.2rem', fontWeight: 600 }}>Nexus IM</h2>
            <button className="btn-primary" style={{ padding: '0.4rem', width: 'auto' }} onClick={() => setShowCreateGroup(true)}>
                <Users size={16} />
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', color: 'var(--success)', marginTop: '10px' }}>
            <div className="status-indicator"></div> {userId}
            <Settings size={16} style={{ cursor: 'pointer', marginLeft: '0.5rem', color: 'var(--text-secondary)' }} onClick={() => setShowSettings(true)} />
            <LogOut size={16} style={{ cursor: 'pointer', marginLeft: '0.5rem', color: 'var(--text-secondary)' }} onClick={handleLogout} />
          </div>
          <div style={{ display: 'flex', marginTop: '15px', borderBottom: '1px solid var(--border)' }}>
              <div onClick={() => setSidebarTab('chats')} style={{ flex: 1, padding: '10px 0', textAlign: 'center', cursor: 'pointer', borderBottom: sidebarTab === 'chats' ? '2px solid var(--accent)' : '2px solid transparent', color: sidebarTab === 'chats' ? 'var(--text)' : 'var(--text-secondary)', fontWeight: sidebarTab === 'chats' ? 600 : 400 }}>Chats</div>
              <div onClick={() => setSidebarTab('calls')} style={{ flex: 1, padding: '10px 0', textAlign: 'center', cursor: 'pointer', borderBottom: sidebarTab === 'calls' ? '2px solid var(--accent)' : '2px solid transparent', color: sidebarTab === 'calls' ? 'var(--text)' : 'var(--text-secondary)', fontWeight: sidebarTab === 'calls' ? 600 : 400 }}>Calls</div>
          </div>
        </div>
        
        {sidebarTab === 'chats' ? (
          <>
        
        {showCreateGroup && (
            <div style={{ padding: '1rem', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)' }}>
                <form onSubmit={createGroup}>
                    <input type="text" className="input-field" placeholder="Group Name..." value={newGroupName} onChange={e => setNewGroupName(e.target.value)} required />
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                        <input type="checkbox" checked={newGroupIsAnnouncement} onChange={e => setNewGroupIsAnnouncement(e.target.checked)} />
                        Announcement Only (Admins Only)
                    </label>
                    <div style={{ display: 'flex', gap: '5px', marginTop: '10px' }}>
                        <button type="submit" className="btn-primary" style={{ flex: 1 }}>Create</button>
                        <button type="button" className="btn-primary" style={{ flex: 1, background: 'var(--border)' }} onClick={() => setShowCreateGroup(false)}>Cancel</button>
                    </div>
                </form>
            </div>
        )}

        <form className="new-chat-form" onSubmit={handleStartNewChat}>
          <input type="text" className="input-field" placeholder="New DM Target ID..." value={newChatTarget} onChange={e => setNewChatTarget(e.target.value)} />
          <button type="submit" className="btn-primary"><MessageSquarePlus size={18} /></button>
        </form>

        <div className="chat-list">
          {chatsWithMeta.map(chat => {
              let previewText = 'Say hello!';
              if (chat.lastMsg) {
                  let isJson = false;
                  try {
                      const parsed = JSON.parse(chat.lastMsg.payload);
                      if (parsed.media) {
                          previewText = `📎 ${parsed.media.name || 'Attachment'}`;
                          isJson = true;
                      } else if (parsed.text) {
                          previewText = stripHtml(parsed.text);
                          isJson = true;
                      }
                  } catch (e) {
                      // Not json
                  }
                  
                  if (!isJson) {
                      previewText = stripHtml(chat.lastMsg.payload);
                  }
                  
                  if (chat.lastMsg.senderId === userId) {
                      previewText = `You: ${previewText}`;
                  }
              } else if (chat.type === 'group') {
                  previewText = `Group • ${chat.meta?.role}`;
              }
                  
              return (
                 <div key={chat.id} className={`chat-list-item ${activeChat === chat.id ? 'active' : ''} ${chat.unreadCount > 0 && activeChat !== chat.id ? 'unread-glow' : ''}`} onClick={() => setActiveChat(chat.id)}>
                    <div className="avatar" style={{ background: chat.type === 'group' ? '#4f46e5' : '#6b7280' }}>
                        {chat.name.substring(0, 1).toUpperCase()}
                    </div>
                    <div className="chat-info" style={{ flex: 1 }}>
                      <div className="chat-name" style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ fontWeight: chat.unreadCount > 0 && activeChat !== chat.id ? 600 : 500 }}>{chat.name}</span>
                          {chat.unreadCount > 0 && activeChat !== chat.id && (
                              <span style={{ background: '#22c55e', color: 'white', borderRadius: '50%', padding: '2px 8px', fontSize: '0.75rem', fontWeight: 600 }}>
                                  {chat.unreadCount}
                              </span>
                          )}
                      </div>
                      <div className="chat-preview" style={{ color: chat.unreadCount > 0 && activeChat !== chat.id ? 'white' : 'var(--text-secondary)', fontWeight: chat.unreadCount > 0 && activeChat !== chat.id ? 500 : 400 }}>
                          {previewText}
                      </div>
                    </div>
                  </div>
              );
          })}
        </div>
          </>
        ) : (
          <div className="chat-list">
             {callHistory.map(call => (
                <div key={call.id} className="chat-list-item" onClick={() => { 
                    if (call.group_id) {
                        setActiveChatIsGroup(true);
                        setActiveChat(call.group_id);
                    } else {
                        setActiveChatIsGroup(false);
                        setActiveChat(call.recipient_id === userId ? call.caller_id : call.recipient_id); 
                    }
                    setSidebarTab('chats'); 
                }}>
                    <div className="avatar" style={{ background: call.call_type === 'video' ? '#8b5cf6' : '#10b981', display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'white' }}>
                        {call.call_type === 'video' ? <Video size={16}/> : <Phone size={16}/>}
                    </div>
                    <div className="chat-info" style={{ flex: 1 }}>
                        <div className="chat-name" style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ fontWeight: 500 }}>{call.group_id ? `Group: ${call.group_id}` : (call.recipient_id === userId ? call.caller_id : call.recipient_id)}</span>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{new Date(call.created_at).toLocaleDateString()}</span>
                        </div>
                        <div className="chat-preview" style={{ color: call.status === 'MISSED' ? '#ef4444' : 'var(--text-secondary)' }}>
                            {call.status === 'MISSED' && call.caller_id === userId ? 'Unanswered' : call.status} • {call.duration_seconds}s
                        </div>
                    </div>
                </div>
             ))}
             {callHistory.length === 0 && <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)' }}>No call history</div>}
          </div>
        )}
      </div>

      {/* MAIN CHAT AREA */}
      <div className="main-chat">
        {!activeChat ? (
          <div className="empty-state">
            <MessageCircle size={64} opacity={0.2} />
            <h2>Select a chat to start messaging</h2>
          </div>
        ) : (
          <>
            <div className="chat-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div className="avatar" style={{ width: '40px', height: '40px', fontSize: '1rem', backgroundImage: !activeChatIsGroup && activeChatAvatar ? `url(${activeChatAvatar})` : 'none', backgroundSize: 'cover' }}>
                  {!activeChatIsGroup && activeChatAvatar ? null : (activeChatIsGroup ? activeGroupMeta?.name.substring(0, 1).toUpperCase() : activeChat.substring(0, 1).toUpperCase())}
                </div>
                <div>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>
                      {activeChatIsGroup ? activeGroupMeta?.name : activeChat}
                      {activeGroupMeta?.is_announcement_only && <span style={{ fontSize: '0.75rem', marginLeft: '10px', background: 'var(--accent)', padding: '2px 6px', borderRadius: '4px' }}>Announcement Only</span>}
                  </h3>
                  {!activeChatIsGroup && (
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                          {activeChatRank && <span>{activeChatRank}</span>}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: activeChatPresence === 'online' ? '#22c55e' : 'var(--text-secondary)' }}></div>
                              {(() => {
                                  if (activeChatPresence === 'online') return 'Online';
                                  if (activeChatPresence === 'offline' || !activeChatPresence) return 'Offline';
                                  const d = new Date(activeChatPresence);
                                  if (isNaN(d.getTime())) return 'Offline';
                                  return `Last seen: ${d.toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'})}`;
                              })()}
                          </div>
                      </div>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <button onClick={() => startCall('audio')} title="Voice Call" style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer', padding: '5px' }}>
                      <Phone size={20} />
                  </button>
                  <button onClick={() => startCall('video')} title="Video Call" style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer', padding: '5px' }}>
                      <Video size={20} />
                  </button>
                  <div style={{ width: '1px', height: '24px', background: 'var(--border)', margin: '0 5px' }}></div>
                  <button onClick={clearChat} style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', padding: '0.4rem 0.8rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 500 }}>
                      Clear Chat
                  </button>
                  {activeChatIsGroup ? (
                      activeGroupMeta?.role === 'admin' && (
                        <button onClick={() => { setShowManageGroup(true); loadGroupMembers(activeChat); }} style={{ background: 'var(--border)', color: 'white', border: 'none', padding: '0.4rem 0.8rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '5px' }}>
                            <Settings size={14} /> Manage
                        </button>
                      )
                  ) : (
                      <button onClick={toggleBlock} style={{ background: blockedUsers.includes(activeChat) ? 'var(--text-secondary)' : '#ef4444', color: 'white', border: 'none', padding: '0.4rem 0.8rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 500 }}>
                        {blockedUsers.includes(activeChat) ? 'Unblock' : 'Block'}
                      </button>
                  )}
              </div>
            </div>

            <div className="chat-messages">
              {activeMessages.map((msg) => {
                const isMe = msg.senderId === userId;
                return (
                  <div key={msg.id} className={`message-bubble ${isMe ? 'message-sent' : 'message-received'}`}>
                    {activeChatIsGroup && !isMe && <div style={{ fontSize: '0.75rem', color: 'var(--accent)', marginBottom: '4px', fontWeight: 600 }}>{msg.senderId}</div>}
                    {msg.is_forwarded && !msg.is_deleted && <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '2px', fontStyle: 'italic' }}>↪️ Forwarded</div>}
                    <div className="message-text" style={{ fontStyle: msg.is_deleted ? 'italic' : 'normal', color: msg.is_deleted ? 'var(--text-secondary)' : 'inherit' }}>
                        {msg.is_deleted ? (
                          '🚫 This message was deleted'
                        ) : (
                          renderMessagePayload(msg)
                        )}
                    </div>
                    <div className="message-meta">
                      <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      {!isMe && !msg.is_deleted && (
                          <span style={{cursor: 'pointer', marginLeft: '5px'}} onClick={() => setReplyingTo(msg)}>↩️ Reply</span>
                      )}
                      {!isMe && activeChatIsGroup && !msg.is_deleted && (
                          <span style={{cursor: 'pointer', marginLeft: '5px'}} onClick={() => {
                              setActiveChat(msg.senderId);
                              setReplyingTo(msg);
                          }}>🤫 Reply Privately</span>
                      )}
                      {!msg.is_deleted && (
                          <span style={{cursor: 'pointer', marginLeft: '5px'}} onClick={() => setForwardingPayload(stripReplyBlock(msg.payload))}>↪️ Forward</span>
                      )}
                      {isMe && !msg.is_deleted && (
                        <span style={{cursor: 'pointer', marginLeft: '5px'}} onClick={() => {
                          if (ws.current?.readyState === WebSocket.OPEN) {
                            ws.current.send(JSON.stringify({ event_type: 'MSG_DELETE', client_message_id: msg.id, timestamp: new Date().toISOString() }));
                          }
                        }}>🗑️</span>
                      )}
                      {isMe && !msg.is_deleted && !activeChatIsGroup && renderTicks(msg.status)}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            <div style={{ position: 'relative' }}>
                {showEmojiPicker && (
                    <div style={{ position: 'absolute', bottom: '100%', right: '20px', zIndex: 100 }}>
                        <EmojiPicker onEmojiClick={(emojiData) => setInputText(prev => prev + emojiData.emoji)} theme={Theme.DARK} />
                    </div>
                )}
                
                {isInputDisabled ? (
                    <div style={{ padding: '1rem', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', textAlign: 'center', borderRadius: '8px', margin: '0.5rem' }}>
                        {placeholderText}
                    </div>
                ) : (
                    <div style={{ background: 'white', borderRadius: '8px', margin: '0.5rem', display: 'flex', flexDirection: 'column' }}>
                        {replyingTo && (
                            <div style={{ background: '#f8fafc', padding: '10px 15px', borderLeft: '4px solid var(--accent)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderRadius: '8px 8px 0 0', borderBottom: '1px solid #e2e8f0' }}>
                                <div>
                                    <div style={{ fontWeight: 600, color: 'var(--accent)', fontSize: '0.85rem' }}>Replying to {replyingTo.senderId}</div>
                                    <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '2px' }}>{stripHtml(replyingTo.payload).substring(0, 50)}...</div>
                                </div>
                                <button type="button" onClick={() => setReplyingTo(null)} style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '1.2rem', padding: '0 5px' }}>×</button>
                            </div>
                        )}
                        <ReactQuill 
                            theme="snow" 
                            value={inputText} 
                            onChange={setInputText} 
                            modules={quillModules}
                            placeholder={placeholderText}
                            style={{ color: 'black' }}
                        />
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem', borderTop: '1px solid #ccc' }}>
                            {isRecording ? (
                                <div style={{ display: 'flex', alignItems: 'center', width: '100%', justifyContent: 'space-between', background: 'var(--bg-primary)', padding: '5px 15px', borderRadius: '20px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                                        <button onClick={cancelRecording} style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                                            <Trash2 size={20} />
                                        </button>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)', fontWeight: 500, fontFamily: 'monospace', fontSize: '1.1rem' }}>
                                            <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: isRecordingPaused ? 'var(--text-secondary)' : '#ef4444', animation: isRecordingPaused ? 'none' : 'pulse 1s infinite' }}></div>
                                            {Math.floor(recordingTime / 60).toString().padStart(2, '0')}:{(recordingTime % 60).toString().padStart(2, '0')}
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                                        {isRecordingPaused ? (
                                            <button onClick={resumeRecording} style={{ background: 'var(--text-secondary)', color: 'white', border: 'none', borderRadius: '50%', width: '36px', height: '36px', cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                                <Play size={18} />
                                            </button>
                                        ) : (
                                            <button onClick={pauseRecording} style={{ background: 'var(--text-secondary)', color: 'white', border: 'none', borderRadius: '50%', width: '36px', height: '36px', cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                                <Pause size={18} />
                                            </button>
                                        )}
                                        <button onClick={stopRecordingAndSend} style={{ background: 'var(--accent)', color: 'white', border: 'none', borderRadius: '50%', width: '36px', height: '36px', cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                            <Send size={16} style={{ marginLeft: '2px' }} />
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div style={{ display: 'flex', gap: '10px' }}>
                                        <button type="button" onClick={() => setShowEmojiPicker(!showEmojiPicker)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '1.5rem' }}>
                                            😀
                                        </button>
                                        <button type="button" onClick={() => fileInputRef.current?.click()} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '1.2rem', display: 'flex', alignItems: 'center', color: 'var(--text-secondary)' }}>
                                            📎
                                        </button>
                                        <input type="file" multiple ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileUpload} />
                                        <button 
                                            type="button" 
                                            onClick={startRecording}
                                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '1.2rem', display: 'flex', alignItems: 'center', color: 'var(--text-secondary)', padding: '5px' }}
                                            title="Record Voice Note"
                                        >
                                            <Mic size={20} />
                                        </button>
                                    </div>
                                    <button type="button" className="btn-primary" onClick={() => sendMessage()} disabled={!inputText.trim() || inputText === '<p><br></p>' || !isConnected}>
                                        <Send size={18} /> Send
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>
          </>
        )}
      </div>

      {/* ADMIN GROUP MANAGE MODAL */}
      {showManageGroup && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
              <div style={{ background: 'var(--bg-secondary)', padding: '2rem', borderRadius: '12px', width: '400px', maxWidth: '90%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
                      <h2 style={{ margin: 0 }}>Manage Group</h2>
                      <button onClick={() => setShowManageGroup(false)} style={{ background: 'transparent', border: 'none', color: 'white', cursor: 'pointer', fontSize: '1.2rem' }}>✕</button>
                  </div>
                  
                  <div style={{ marginBottom: '1rem', padding: '1rem', background: 'var(--bg-primary)', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 500 }}>Announcement Mode</span>
                      <label className="switch" style={{ cursor: 'pointer' }}>
                        <input type="checkbox" checked={activeGroupMeta?.is_announcement_only || false} onChange={() => toggleAnnouncement(activeGroupMeta!.is_announcement_only)} />
                        <span style={{ marginLeft: '10px' }}>{activeGroupMeta?.is_announcement_only ? 'ON' : 'OFF'}</span>
                      </label>
                  </div>

                  <form onSubmit={addGroupMember} style={{ display: 'flex', gap: '10px', marginBottom: '1rem' }}>
                      <input type="text" className="input-field" placeholder="Add User ID..." value={newMemberId} onChange={e => setNewMemberId(e.target.value)} required />
                      <button type="submit" className="btn-primary" style={{ width: 'auto' }}>Add</button>
                  </form>

                  <div style={{ maxHeight: '200px', overflowY: 'auto', background: 'var(--bg-primary)', borderRadius: '8px', padding: '0.5rem' }}>
                      {groupMembers.map(m => (
                          <div key={m.user_id} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem', borderBottom: '1px solid var(--border)' }}>
                              <div>
                                  <div>{m.user_id} {m.user_id === userId && '(You)'}</div>
                                  <div style={{ fontSize: '0.75rem', color: 'var(--accent)' }}>{m.role}</div>
                              </div>
                              {m.user_id !== userId && (
                                  <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                                      {m.role !== 'admin' && <button onClick={() => promoteMember(m.user_id)} style={{ fontSize: '0.7rem', padding: '2px 5px', background: 'var(--accent)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Make Admin</button>}
                                      <button onClick={() => removeMember(m.user_id)} style={{ fontSize: '0.7rem', padding: '2px 5px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Remove</button>
                                  </div>
                              )}
                          </div>
                      ))}
                  </div>

                  <div style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border)', paddingTop: '1rem', textAlign: 'center' }}>
                      <button onClick={deleteGroup} style={{ background: '#ef4444', color: 'white', padding: '0.6rem 1rem', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, width: '100%' }}>
                          Delete Group
                      </button>
                  </div>
              </div>
          </div>
      )}

      {forwardingPayload && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
              <div style={{ background: 'var(--bg-secondary)', padding: '2rem', borderRadius: '12px', width: '400px', maxWidth: '90%', display: 'flex', flexDirection: 'column', maxHeight: '80vh' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
                      <h2 style={{ margin: 0 }}>Forward Message</h2>
                      <button onClick={() => { setForwardingPayload(null); setForwardSearch(''); }} style={{ background: 'transparent', border: 'none', color: 'white', cursor: 'pointer', fontSize: '1.2rem' }}>✕</button>
                  </div>
                  
                  <input type="text" className="input-field" placeholder="Search chats..." value={forwardSearch} onChange={e => setForwardSearch(e.target.value)} style={{ marginBottom: '1rem' }} />

                  <div style={{ overflowY: 'auto', flex: 1, background: 'var(--bg-primary)', borderRadius: '8px', padding: '0.5rem' }}>
                      {chatsWithMeta.filter(c => c.name.toLowerCase().includes(forwardSearch.toLowerCase())).map(chat => (
                          <div key={chat.id} onClick={() => forwardMessage(chat.id, chat.type === 'group')} style={{ padding: '0.8rem', borderBottom: '1px solid var(--border)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px' }}>
                              <div className="avatar" style={{ background: chat.type === 'group' ? '#4f46e5' : '#6b7280', width: '32px', height: '32px', fontSize: '0.8rem' }}>
                                  {chat.name.substring(0, 1).toUpperCase()}
                              </div>
                              <span style={{ fontWeight: 500 }}>{chat.name}</span>
                          </div>
                      ))}
                      {chatsWithMeta.filter(c => c.name.toLowerCase().includes(forwardSearch.toLowerCase())).length === 0 && (
                          <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No chats found.</div>
                      )}
                  </div>
              </div>
          </div>
      )}

      {showSettings && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
              <div style={{ background: 'var(--bg-secondary)', padding: '2rem', borderRadius: '12px', width: '400px', maxWidth: '90%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
                      <h2 style={{ margin: 0 }}>My Profile Settings</h2>
                      <button onClick={() => setShowSettings(false)} style={{ background: 'transparent', border: 'none', color: 'white', cursor: 'pointer', fontSize: '1.2rem' }}>✕</button>
                  </div>
                  <form onSubmit={saveSettings}>
                      <div style={{ marginBottom: '1rem' }}>
                          <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '5px' }}>Profile Picture URL</label>
                          <input type="url" className="input-field" placeholder="https://example.com/avatar.png" value={profilePicUrl} onChange={e => setProfilePicUrl(e.target.value)} />
                      </div>
                      <div style={{ marginBottom: '1.5rem' }}>
                          <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '5px' }}>Rank / Title</label>
                          <input type="text" className="input-field" placeholder="e.g. Commander" value={rank} onChange={e => setRank(e.target.value)} />
                      </div>
                      <button type="submit" className="btn-primary" style={{ width: '100%' }}>Save Settings</button>
                  </form>
              </div>
          </div>
      )}

      {/* CALL UI: Outbound Ringing */}
      {outboundCall && (
          <div style={{ position: 'fixed', bottom: '30px', right: '30px', background: 'var(--bg-secondary)', padding: '20px', borderRadius: '12px', boxShadow: '0 10px 25px rgba(0,0,0,0.5)', zIndex: 999, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '20px' }}>
              <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'var(--accent)', display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'white', animation: 'pulse 1.5s infinite' }}>
                  <Phone size={20} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontWeight: 600 }}>Calling {outboundCall}...</span>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Waiting for answer</span>
              </div>
              <button onClick={() => { setOutboundCall(null); /* In a real app we'd send CALL_ENDED here */ }} style={{ background: '#ef4444', color: 'white', border: 'none', padding: '10px', borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                  <PhoneOff size={20} />
              </button>
          </div>
      )}

      {/* CALL UI: Incoming Call Modal */}
      {incomingCall && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
              <div style={{ background: 'var(--bg-secondary)', padding: '40px', borderRadius: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', boxShadow: '0 20px 50px rgba(0,0,0,0.5)', border: '1px solid var(--border)', minWidth: '300px' }}>
                  <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: 'var(--accent)', display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'white', fontSize: '2rem', animation: 'pulse 1.5s infinite' }}>
                      {incomingCall.call_type === 'video' ? <Video size={40} /> : <Phone size={40} />}
                  </div>
                  <div style={{ textAlign: 'center' }}>
                      <h2 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>{incomingCall.sender_id}</h2>
                      <p style={{ margin: '5px 0 0', color: 'var(--text-secondary)' }}>Incoming {incomingCall.call_type} call...</p>
                  </div>
                  <div style={{ display: 'flex', gap: '20px', marginTop: '10px' }}>
                      <button onClick={rejectCall} style={{ background: '#ef4444', color: 'white', border: 'none', width: '50px', height: '50px', borderRadius: '50%', cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                          <PhoneOff size={24} />
                      </button>
                      <button onClick={acceptCall} style={{ background: '#22c55e', color: 'white', border: 'none', width: '50px', height: '50px', borderRadius: '50%', cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                          <Phone size={24} />
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* CALL UI: LiveKit WebRTC Overlay */}
      {livekitToken && activeCallRoom && (
          <CallRoom 
              token={livekitToken} 
              callType={activeCallType}
              callKey={callKey}
              onLeave={() => {
                  setLivekitToken(null);
                  setActiveCallRoom(null);
                  setCallKey(null);
                  if (ws.current) {
                      ws.current.send(JSON.stringify({
                          event_type: 'CALL_ENDED',
                          client_message_id: crypto.randomUUID(),
                          recipient_id: activeChatIsGroup ? null : activeChat,
                          group_id: activeChatIsGroup ? activeChat : null,
                          room_id: activeCallRoom,
                          timestamp: new Date().toISOString()
                      }));
                  }
              }} 
          />
      )}

      <style>{`
          @keyframes pulse {
              0% { box-shadow: 0 0 0 0 rgba(79, 70, 229, 0.7); }
              70% { box-shadow: 0 0 0 20px rgba(79, 70, 229, 0); }
              100% { box-shadow: 0 0 0 0 rgba(79, 70, 229, 0); }
          }
      `}</style>
    </div>
  );
}

export default App;
