import {
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
} from 'firebase/firestore';
import {
  db,
  auth,
  saveCommentToPublicServer,
  deleteCommentFromPublicServer,
} from './firebase';
import { InteractiveComment } from '../types';

const LIKED_COMMENTS_KEY = 'qalami_liked_comments_v1';
const DELETED_COMMENTS_KEY = 'qalami_deleted_comments_v1';
const COMMENTS_PREFIX = 'qalami_comments_';

type CommentsListener = (comments: InteractiveComment[]) => void;
const targetListeners = new Map<string, Set<CommentsListener>>();

function getDeletedCommentIdSet(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(DELETED_COMMENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id) : []);
  } catch {
    return new Set();
  }
}

function addDeletedCommentIds(ids: string[]): Set<string> {
  const set = getDeletedCommentIdSet();
  let added = false;
  for (const id of ids) {
    if (typeof id === 'string' && id && !set.has(id)) {
      set.add(id);
      added = true;
    }
  }
  if (added && typeof window !== 'undefined') {
    try {
      localStorage.setItem(DELETED_COMMENTS_KEY, JSON.stringify(Array.from(set).slice(-5000)));
    } catch {
      // ignore
    }
  }
  return set;
}

function getLocalLikedIds(): string[] {
  try {
    const raw = localStorage.getItem(LIKED_COMMENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setLocalLikedIds(ids: string[]): void {
  try {
    localStorage.setItem(LIKED_COMMENTS_KEY, JSON.stringify(ids));
  } catch {
    // ignore
  }
}

function getLocalCache(targetId: string): InteractiveComment[] {
  try {
    const deletedSet = getDeletedCommentIdSet();
    const raw = localStorage.getItem(`${COMMENTS_PREFIX}${targetId}`);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((c) => c?.id && !deletedSet.has(c.id)) : [];
  } catch {
    return [];
  }
}

function setLocalCache(targetId: string, comments: InteractiveComment[]): void {
  try {
    const deletedSet = getDeletedCommentIdSet();
    const filtered = comments.filter((c) => c?.id && !deletedSet.has(c.id));
    localStorage.setItem(`${COMMENTS_PREFIX}${targetId}`, JSON.stringify(filtered));
  } catch {
    // ignore
  }
}

function notifyTargetListeners(targetId: string): void {
  const subs = targetListeners.get(targetId);
  if (!subs || subs.size === 0) return;
  const likedIds = getLocalLikedIds();
  const payload = getLocalCache(targetId).map((c) => ({
    ...c,
    likedByUser: likedIds.includes(c.id),
  }));
  subs.forEach((fn) => {
    try {
      fn(payload);
    } catch {
      // ignore
    }
  });
}

export const CommentService = {
  subscribeToComments(
    targetId: string,
    onData: (comments: InteractiveComment[]) => void
  ): () => void {
    const path = 'comments';
    const likedIds = getLocalLikedIds();

    let subs = targetListeners.get(targetId);
    if (!subs) {
      subs = new Set();
      targetListeners.set(targetId, subs);
    }
    subs.add(onData);

    // 1. Initial immediate emit from local cache for instant UI rendering
    const cached = getLocalCache(targetId).map((c) => ({
      ...c,
      likedByUser: likedIds.includes(c.id),
    }));
    onData(cached);

    // 2. Setup Firebase Firestore real-time listener
    const q = query(collection(db, path), where('targetId', '==', targetId));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const deletedIdsFromFirestore = snapshot
          .docChanges()
          .filter((change) => change.type === 'removed')
          .map((change) => change.doc.id);
        if (deletedIdsFromFirestore.length > 0) {
          addDeletedCommentIds(deletedIdsFromFirestore);
        }

        const deletedSet = getDeletedCommentIdSet();
        const latestLiked = getLocalLikedIds();
        const firestoreMap = new Map<string, InteractiveComment>();
        snapshot.forEach((snap) => {
          const data = snap.data() as InteractiveComment;
          if (data?.id && !deletedSet.has(data.id)) {
            firestoreMap.set(data.id, {
              ...data,
              likedByUser: latestLiked.includes(data.id),
            });
          }
        });

        // Merge with existing local/public relay comments not yet deleted
        const localExisting = getLocalCache(targetId);
        for (const lc of localExisting) {
          if (lc?.id && !deletedSet.has(lc.id) && !firestoreMap.has(lc.id)) {
            firestoreMap.set(lc.id, {
              ...lc,
              likedByUser: latestLiked.includes(lc.id),
            });
          }
        }

        const merged = Array.from(firestoreMap.values()).sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

        setLocalCache(targetId, merged);
        onData(merged);
      },
      (error) => {
        console.warn('Firestore comments subscription fallback to local cache:', error);
        const local = getLocalCache(targetId).map((c) => ({
          ...c,
          likedByUser: getLocalLikedIds().includes(c.id),
        }));
        onData(local);
      }
    );

    return () => {
      unsubscribe();
      const currentSubs = targetListeners.get(targetId);
      if (currentSubs) {
        currentSubs.delete(onData);
        if (currentSubs.size === 0) targetListeners.delete(targetId);
      }
    };
  },

  async addComment(params: {
    targetId: string;
    targetType: 'video' | 'document';
    content: string;
    role?: 'student' | 'teacher' | 'parent';
    userName?: string;
    userPhotoURL?: string;
  }): Promise<InteractiveComment> {
    const user = auth.currentUser;
    const commentId = `cm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const createdAt = new Date().toISOString();

    const newComment: InteractiveComment = {
      id: commentId,
      targetId: params.targetId,
      targetType: params.targetType,
      userId: user?.uid || 'guest_student',
      userName: params.userName || user?.displayName || 'طالب مجتهد',
      userPhotoURL: params.userPhotoURL || user?.photoURL || undefined,
      role: params.role || 'student',
      content: params.content.trim(),
      likesCount: 0,
      likedByUser: false,
      createdAt,
    };

    // 1. Optimistically write to local storage and notify UI
    const currentLocal = getLocalCache(params.targetId);
    const updatedLocal = [newComment, ...currentLocal];
    setLocalCache(params.targetId, updatedLocal);
    notifyTargetListeners(params.targetId);

    // 2. Sync to zero-login public relay
    saveCommentToPublicServer(newComment).catch(() => {});

    // 3. Persist to Firebase Firestore if online & signed in
    if (user) {
      try {
        const commentRef = doc(db, 'comments', commentId);
        const dataToSave = {
          id: commentId,
          targetId: String(params.targetId).slice(0, 128),
          targetType: params.targetType,
          userId: user.uid,
          userName: String(newComment.userName || 'طالب').trim().slice(0, 100) || 'طالب',
          userPhotoURL: String(newComment.userPhotoURL || '').slice(0, 990000),
          role: newComment.role || 'student',
          content: String(newComment.content || '').trim().slice(0, 2000),
          likesCount: 0,
          createdAt,
        };
        await setDoc(commentRef, dataToSave);
      } catch (err) {
        console.warn('Firestore comment save note:', err);
      }
    }

    // 4. Dual-persist to PostgreSQL / Cloud SQL backend
    try {
      fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: newComment.id,
          targetId: newComment.targetId,
          targetType: newComment.targetType,
          userId: newComment.userId,
          authorName: newComment.userName,
          authorPhoto: newComment.userPhotoURL,
          authorRole: newComment.role,
          content: newComment.content,
          reaction: null,
          likesCount: 0,
        }),
      }).catch(() => {});
    } catch {
      // non-blocking
    }

    return newComment;
  },

  async deleteComment(commentId: string, targetId: string): Promise<void> {
    addDeletedCommentIds([commentId]);

    // 1. Remove from local cache & notify UI immediately
    const currentLocal = getLocalCache(targetId);
    const updated = currentLocal.filter((c) => c.id !== commentId);
    setLocalCache(targetId, updated);
    notifyTargetListeners(targetId);

    // 2. Delete from public cross-device relay
    deleteCommentFromPublicServer(commentId, targetId).catch(() => {});

    // 3. Delete from Firebase if signed in
    if (auth.currentUser) {
      try {
        const commentRef = doc(db, 'comments', commentId);
        await deleteDoc(commentRef);
      } catch (err) {
        console.warn('Firestore comment delete note:', err);
      }
    }

    // 4. Delete from PostgreSQL / Cloud SQL backend
    try {
      fetch(`/api/comments/${commentId}`, { method: 'DELETE' }).catch(() => {});
    } catch {
      // non-blocking
    }
  },

  mergePublicComments(comments: InteractiveComment[]): void {
    if (!Array.isArray(comments) || comments.length === 0) return;
    const deletedSet = getDeletedCommentIdSet();
    const byTarget = new Map<string, InteractiveComment[]>();

    for (const c of comments) {
      if (!c?.id || !c.targetId || deletedSet.has(c.id)) continue;
      const arr = byTarget.get(c.targetId) || [];
      arr.push(c);
      byTarget.set(c.targetId, arr);
    }

    for (const [targetId, incoming] of byTarget.entries()) {
      const local = getLocalCache(targetId);
      let changed = false;
      const next = [...local];
      for (const rc of incoming) {
        if (!next.some((lc) => lc.id === rc.id)) {
          next.push(rc);
          changed = true;
        }
      }
      if (changed) {
        next.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        setLocalCache(targetId, next);
        notifyTargetListeners(targetId);
      }
    }
  },

  reconcileDeletedComments(deletedIds: string[], targetIdHint?: string): void {
    if (!Array.isArray(deletedIds) || deletedIds.length === 0) return;
    const deletedSet = addDeletedCommentIds(deletedIds);

    if (typeof window === 'undefined') return;
    const touchedTargets = new Set<string>();
    if (targetIdHint) touchedTargets.add(targetIdHint);

    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(COMMENTS_PREFIX)) keys.push(k);
      }
      for (const key of keys) {
        const targetId = key.slice(COMMENTS_PREFIX.length);
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) continue;
        const filtered = parsed.filter((c) => c?.id && !deletedSet.has(c.id));
        if (filtered.length !== parsed.length) {
          localStorage.setItem(key, JSON.stringify(filtered));
          touchedTargets.add(targetId);
        }
      }
    } catch {
      // ignore
    }

    for (const targetId of touchedTargets) {
      notifyTargetListeners(targetId);
    }
  },

  async toggleLikeComment(commentId: string, targetId: string): Promise<boolean> {
    const liked = getLocalLikedIds();
    let isNowLiked = false;
    let nextLiked: string[];

    if (liked.includes(commentId)) {
      nextLiked = liked.filter((id) => id !== commentId);
      isNowLiked = false;
    } else {
      nextLiked = [...liked, commentId];
      isNowLiked = true;
    }
    setLocalLikedIds(nextLiked);

    // Update local cache & notify
    const currentLocal = getLocalCache(targetId);
    const comment = currentLocal.find((c) => c.id === commentId);
    let nextLikesCount = 0;
    if (comment) {
      nextLikesCount = Math.max(0, (comment.likesCount || 0) + (isNowLiked ? 1 : -1));
      comment.likesCount = nextLikesCount;
      comment.likedByUser = isNowLiked;
      setLocalCache(targetId, currentLocal);
      notifyTargetListeners(targetId);
    }

    // Update in Firebase Firestore (updateDoc only so non-existent local comments don't trigger invalid create)
    if (auth.currentUser) {
      try {
        const commentRef = doc(db, 'comments', commentId);
        await updateDoc(commentRef, { likesCount: nextLikesCount });
      } catch (e) {
        console.warn('Firestore comment like update note:', e);
      }
    }

    return isNowLiked;
  },
};

