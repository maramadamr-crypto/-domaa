import { VideoItem, VideoType } from '../types';
import {
  auth,
  saveVideoToFirestore,
  saveVideoToPublicServer,
  deleteVideoFromFirestore,
  updateVideoLikeInFirestore,
} from './firebase';

const STORAGE_KEYS = {
  VIDEOS: 'qalami_videos_store_v1',
  LIKED_VIDEOS: 'qalami_liked_videos_v1',
  DELETED_VIDEOS: 'qalami_deleted_videos_v1',
};

function getDeletedVideoIdSet(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.DELETED_VIDEOS);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id) : []);
  } catch {
    return new Set();
  }
}

function addDeletedVideoIds(ids: string[]): Set<string> {
  const set = getDeletedVideoIdSet();
  let added = false;
  for (const id of ids) {
    if (typeof id === 'string' && id && !set.has(id)) {
      set.add(id);
      added = true;
    }
  }
  if (added && typeof window !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEYS.DELETED_VIDEOS, JSON.stringify(Array.from(set).slice(-5000)));
    } catch {
      // ignore
    }
  }
  return set;
}

export const DEMO_VIDEOS: VideoItem[] = [
  // 1. فيديو تجريبي واحد في Shorts (أقل من 3 دقائق)
  {
    id: 'demo_short_01',
    title: 'مراجعة سريعة: كان وأخواتها في 45 ثانية ⚡',
    description: 'درس تجريبي سريع: تعرف على كان وأخواتها وأثرها على المبتدأ والخبر بطريقة سريعة ومبسطة.',
    videoUrl: '/videos/demo_short.mp4',
    thumbnailUrl: '/videos/demo_short_thumb.jpg',
    durationSeconds: 45, // Shorts (<= 180s)
    type: 'shorts',
    subject: 'arabic',
    grade: 'الصف الخامس الابتدائي',
    userId: 'teacher_demo_01',
    author: 'أستاذ أحمد الشناوي',
    authorPhoto: '',
    likesCount: 0,
    likedByUser: false,
    sharesCount: 0,
    commentsCount: 0,
    comments: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  // 2. فيديو تجريبي واحد في الدروس (أكثر من 3 دقائق)
  {
    id: 'demo_lesson_01',
    title: 'شرح كامل: القواعد النحوية ومراجعة ليلة الامتحان 📖',
    description: 'درس تجريبي كامل وشامل: شرح كافة دروس النحو المقررة وحل التدريبات والأنشطة النموذجية خطوة بخطوة.',
    videoUrl: '/videos/demo_lesson.mp4',
    thumbnailUrl: '/videos/demo_lesson_thumb.jpg',
    durationSeconds: 305, // Lesson (> 180s)
    type: 'lesson',
    subject: 'arabic',
    grade: 'الصف الخامس الابتدائي',
    userId: 'teacher_demo_02',
    author: 'أستاذ محمد إبراهيم',
    authorPhoto: '',
    likesCount: 0,
    likedByUser: false,
    sharesCount: 0,
    commentsCount: 0,
    comments: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

let inMemoryVideos: VideoItem[] = [];

// Load stored videos or initialize with demo videos unless deleted
if (typeof window !== 'undefined') {
  const deletedSet = getDeletedVideoIdSet();
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.VIDEOS);
    let list: VideoItem[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed;
      } catch {
        // ignore
      }
    }

    // Auto-migrate any old broken Google Cloud Storage 403 URLs to the working local video assets
    list = list
      .filter((v) => v?.id && !deletedSet.has(v.id))
      .map((v) => {
        if (v.id === 'demo_short_01' || v.videoUrl?.includes('gtv-videos-bucket') || v.videoUrl?.includes('ForBiggerBlazes')) {
          return {
            ...DEMO_VIDEOS[0],
            likesCount: v.likesCount || 0,
            likedByUser: v.likedByUser || false,
          };
        }
        if (v.id === 'demo_lesson_01' || v.videoUrl?.includes('BigBuckBunny')) {
          return {
            ...DEMO_VIDEOS[1],
            likesCount: v.likesCount || 0,
            likedByUser: v.likedByUser || false,
          };
        }
        return v;
      });

    const hasShort = list.some((v) => v.type === 'shorts');
    const hasLesson = list.some((v) => v.type === 'lesson');
    if (!hasShort && !deletedSet.has('demo_short_01')) {
      list.push(DEMO_VIDEOS[0]);
    }
    if (!hasLesson && !deletedSet.has('demo_lesson_01')) {
      list.push(DEMO_VIDEOS[1]);
    }
    inMemoryVideos = list;
    localStorage.setItem(STORAGE_KEYS.VIDEOS, JSON.stringify(inMemoryVideos));
  } catch (e) {
    console.warn('Could not read videos from storage', e);
    inMemoryVideos = DEMO_VIDEOS.filter((v) => !deletedSet.has(v.id));
  }

  // Merge any persisted remote videos (skipping deleted and expired cross-device blob: URLs)
  fetch('/api/videos')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data?.success || !Array.isArray(data.videos)) return;
      const latestDeleted = getDeletedVideoIdSet();
      let changed = false;
      for (const rv of data.videos) {
        if (!rv?.id || latestDeleted.has(rv.id) || !rv.videoUrl || String(rv.videoUrl).startsWith('blob:')) continue;
        if (!inMemoryVideos.some((lv) => lv.id === rv.id)) {
          inMemoryVideos.push({
            ...rv,
            type: rv.type === 'lesson' ? 'lesson' : 'shorts',
            sharesCount: rv.sharesCount || 0,
            commentsCount: rv.commentsCount || 0,
            likesCount: rv.likesCount || 0,
          });
          changed = true;
        }
      }
      if (changed) {
        localStorage.setItem(STORAGE_KEYS.VIDEOS, JSON.stringify(inMemoryVideos));
        notifyListeners();
      }
    })
    .catch(() => {});
}

type VideoListener = (videos: VideoItem[]) => void;
const listeners: VideoListener[] = [];

function notifyListeners() {
  const current = [...inMemoryVideos];
  listeners.forEach((fn) => {
    try {
      fn(current);
    } catch (e) {
      console.warn('Video listener error', e);
    }
  });
}

export const VideoService = {
  subscribe(listener: VideoListener): () => void {
    listeners.push(listener);
    listener([...inMemoryVideos]);
    return () => {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  },

  getAllVideos(): VideoItem[] {
    const likedIds = this.getLikedVideoIds();
    return inMemoryVideos.map((v) => ({
      ...v,
      likedByUser: likedIds.includes(v.id),
    }));
  },

  getShorts(): VideoItem[] {
    return this.getAllVideos().filter((v) => v.type === 'shorts');
  },

  getLessons(): VideoItem[] {
    return this.getAllVideos().filter((v) => v.type === 'lesson');
  },

  getVideosByAuthor(authorOrUserId: string): VideoItem[] {
    const term = authorOrUserId.trim().toLowerCase();
    return this.getAllVideos().filter(
      (v) =>
        v.userId === authorOrUserId ||
        v.author.trim().toLowerCase() === term
    );
  },

  saveVideo(videoData: Omit<VideoItem, 'type' | 'likesCount' | 'sharesCount' | 'commentsCount'> & { type?: VideoType; likesCount?: number }): VideoItem {
    const duration = Math.max(1, Math.round(videoData.durationSeconds || 1));
    const resolvedType: VideoType = videoData.type ?? (duration <= 180 ? 'shorts' : 'lesson');

    const newVideo: VideoItem = {
      ...videoData,
      durationSeconds: duration,
      type: resolvedType,
      likesCount: videoData.likesCount ?? 0,
      sharesCount: 0,
      commentsCount: 0,
      comments: [],
      createdAt: videoData.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const existingIndex = inMemoryVideos.findIndex((v) => v.id === newVideo.id);
    if (existingIndex >= 0) {
      inMemoryVideos[existingIndex] = newVideo;
    } else {
      inMemoryVideos.unshift(newVideo);
    }

    this.persistToLocalStorage();
    notifyListeners();

    // Persist to Firebase Firestore + Public Server Relay
    saveVideoToFirestore(newVideo).catch(() => {});

    // Asynchronously sync with Cloud SQL PostgreSQL backend
    if (auth.currentUser) {
      auth.currentUser.getIdToken().then((token) => {
        fetch('/api/videos', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(newVideo),
        }).catch((err) => console.warn('PostgreSQL video sync note:', err));
      }).catch(() => {});
    }

    return newVideo;
  },

  deleteVideo(videoId: string): void {
    addDeletedVideoIds([videoId]);
    inMemoryVideos = inMemoryVideos.filter((v) => v.id !== videoId);
    this.persistToLocalStorage();
    notifyListeners();

    deleteVideoFromFirestore(videoId).catch(() => {});

    if (auth.currentUser) {
      auth.currentUser.getIdToken().then((token) => {
        fetch(`/api/videos/${videoId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch((err) => console.warn('PostgreSQL video delete note:', err));
      }).catch(() => {});
    }
  },

  reconcileDeletedVideos(deletedIds: string[]): void {
    if (!Array.isArray(deletedIds) || deletedIds.length === 0) return;
    const deletedSet = addDeletedVideoIds(deletedIds);
    const next = inMemoryVideos.filter((v) => !deletedSet.has(v.id));
    if (next.length !== inMemoryVideos.length) {
      inMemoryVideos = next;
      this.persistToLocalStorage();
      notifyListeners();
    }
  },

  updateVideo(videoId: string, updates: { title?: string; description?: string }): void {
    const v = inMemoryVideos.find((item) => item.id === videoId);
    if (v) {
      if (updates.title) v.title = updates.title;
      if (updates.description !== undefined) v.description = updates.description;
      v.updatedAt = new Date().toISOString();
      this.persistToLocalStorage();
      notifyListeners();
      saveVideoToFirestore(v).catch(() => {});
    }
  },

  toggleLike(videoId: string): boolean {
    const liked = this.getLikedVideoIds();
    let isNowLiked = false;
    let nextLiked: string[];

    if (liked.includes(videoId)) {
      nextLiked = liked.filter((id) => id !== videoId);
      isNowLiked = false;
    } else {
      nextLiked = [...liked, videoId];
      isNowLiked = true;
    }

    try {
      localStorage.setItem(STORAGE_KEYS.LIKED_VIDEOS, JSON.stringify(nextLiked));
    } catch {
      // ignore
    }

    const video = inMemoryVideos.find((v) => v.id === videoId);
    if (video) {
      video.likesCount = Math.max(0, (video.likesCount || 0) + (isNowLiked ? 1 : -1));
      this.persistToLocalStorage();
      notifyListeners();
      updateVideoLikeInFirestore(videoId, video.likesCount).catch(() => {});
    }

    return isNowLiked;
  },

  mergeCloudVideos(cloudVideos: VideoItem[]): void {
    if (!Array.isArray(cloudVideos) || cloudVideos.length === 0) return;
    const deletedSet = getDeletedVideoIdSet();
    let changed = false;

    for (const remote of cloudVideos) {
      if (!remote?.id || deletedSet.has(remote.id)) continue;
      const idx = inMemoryVideos.findIndex((v) => v.id === remote.id);

      if (idx >= 0) {
        const local = inMemoryVideos[idx];
        const remoteTime = new Date(remote.updatedAt || remote.createdAt || 0).getTime();
        const localTime = new Date(local.updatedAt || local.createdAt || 0).getTime();

        if (
          remoteTime > localTime ||
          (remote.likesCount || 0) !== (local.likesCount || 0) ||
          (remote.commentsCount || 0) !== (local.commentsCount || 0)
        ) {
          inMemoryVideos[idx] = {
            ...local,
            ...remote,
            videoUrl: remote.videoUrl || local.videoUrl || '',
            thumbnailUrl: remote.thumbnailUrl || local.thumbnailUrl || '',
            authorPhoto: remote.authorPhoto || local.authorPhoto || '',
            comments: local.comments || remote.comments || [],
          };
          changed = true;
        }
      } else {
        if (!remote.videoUrl && remote.userId !== auth.currentUser?.uid) continue;
        inMemoryVideos.push({
          ...remote,
          comments: remote.comments || [],
        });
        changed = true;
      }
    }

    if (changed) {
      this.persistToLocalStorage();
      notifyListeners();
    }
  },

  syncLocalVideosToPublicServer(): void {
    const deletedSet = getDeletedVideoIdSet();
    for (const v of inMemoryVideos) {
      if (!v?.id || deletedSet.has(v.id)) continue;
      if (v.id === 'demo_short_01' || v.id === 'demo_lesson_01') continue;
      if (v.videoUrl && String(v.videoUrl).startsWith('blob:')) continue;
      saveVideoToPublicServer(v).catch(() => {});
    }
  },

  syncLocalVideosToFirestore(): void {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const deletedSet = getDeletedVideoIdSet();
    for (const v of inMemoryVideos) {
      if (!v?.id || deletedSet.has(v.id)) continue;
      if (v.id === 'demo_short_01' || v.id === 'demo_lesson_01') continue;
      if (!v.userId || v.userId === 'guest_user' || v.userId === uid) {
        if (!v.userId || v.userId === 'guest_user') {
          v.userId = uid;
        }
        saveVideoToFirestore(v).catch(() => {});
      }
    }
  },

  getLikedVideoIds(): string[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.LIKED_VIDEOS);
      if (raw) return JSON.parse(raw);
    } catch {
      // ignore
    }
    return [];
  },

  persistToLocalStorage(): void {
    try {
      localStorage.setItem(STORAGE_KEYS.VIDEOS, JSON.stringify(inMemoryVideos));
    } catch (e) {
      console.warn('LocalStorage video quota note:', e);
    }
  },

  resetToDemoVideos(): void {
    try {
      const set = getDeletedVideoIdSet();
      set.delete('demo_short_01');
      set.delete('demo_lesson_01');
      localStorage.setItem(STORAGE_KEYS.DELETED_VIDEOS, JSON.stringify(Array.from(set)));
    } catch {
      // ignore
    }
    inMemoryVideos = [...DEMO_VIDEOS];
    this.persistToLocalStorage();
    notifyListeners();
  },

  clearAllVideos(): void {
    addDeletedVideoIds(inMemoryVideos.map((v) => v.id));
    inMemoryVideos = [];
    this.persistToLocalStorage();
    notifyListeners();
  },
};


