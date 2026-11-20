import { InteractiveQuiz } from '../types';
import {
  auth,
  saveQuizToFirestore,
  saveQuizToPublicServer,
  deleteQuizFromFirestore,
  recordQuizAttemptInFirestore,
} from './firebase';

const STORAGE_KEYS = {
  QUIZZES: 'qalami_quizzes_store_v1',
  COMPLETED_QUIZZES: 'qalami_completed_quizzes_v1',
  DELETED_QUIZZES: 'qalami_deleted_quizzes_v1',
};

function getDeletedQuizIdSet(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.DELETED_QUIZZES);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id) : []);
  } catch {
    return new Set();
  }
}

function addDeletedQuizIds(ids: string[]): Set<string> {
  const set = getDeletedQuizIdSet();
  let added = false;
  for (const id of ids) {
    if (typeof id === 'string' && id && !set.has(id)) {
      set.add(id);
      added = true;
    }
  }
  if (added && typeof window !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEYS.DELETED_QUIZZES, JSON.stringify(Array.from(set).slice(-5000)));
    } catch {
      // ignore
    }
  }
  return set;
}

// Initial quizzes list must be completely EMPTY per user request!
let inMemoryQuizzes: InteractiveQuiz[] = [];

if (typeof window !== 'undefined') {
  const deletedSet = getDeletedQuizIdSet();
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.QUIZZES);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        inMemoryQuizzes = parsed.filter((q) => q?.id && !deletedSet.has(q.id));
      }
    }
  } catch (e) {
    console.warn('Could not read quizzes from storage', e);
  }
}

type QuizListener = (quizzes: InteractiveQuiz[]) => void;
const listeners: QuizListener[] = [];

function notifyListeners() {
  const current = [...inMemoryQuizzes];
  listeners.forEach((fn) => {
    try {
      fn(current);
    } catch (e) {
      console.warn('Quiz listener error', e);
    }
  });
}

export const QuizService = {
  subscribe(listener: QuizListener): () => void {
    listeners.push(listener);
    listener([...inMemoryQuizzes]);
    return () => {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  },

  getAllQuizzes(): InteractiveQuiz[] {
    return [...inMemoryQuizzes];
  },

  getQuizzesByAuthor(authorOrUserId: string): InteractiveQuiz[] {
    const term = authorOrUserId.trim().toLowerCase();
    return inMemoryQuizzes.filter(
      (q) => q.userId === authorOrUserId || q.author.trim().toLowerCase() === term
    );
  },

  saveQuiz(quizData: InteractiveQuiz): InteractiveQuiz {
    const existingIndex = inMemoryQuizzes.findIndex((q) => q.id === quizData.id);
    if (existingIndex >= 0) {
      inMemoryQuizzes[existingIndex] = quizData;
    } else {
      inMemoryQuizzes.unshift(quizData);
    }

    try {
      localStorage.setItem(STORAGE_KEYS.QUIZZES, JSON.stringify(inMemoryQuizzes));
    } catch {
      // ignore
    }

    notifyListeners();

    // Persist to Firebase Firestore + Public Server Relay
    saveQuizToFirestore(quizData).catch(() => {});

    // Asynchronously sync with Cloud SQL PostgreSQL backend
    if (auth.currentUser) {
      auth.currentUser.getIdToken().then((token) => {
        fetch('/api/quizzes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            id: quizData.id,
            userId: quizData.userId,
            author: quizData.author,
            title: quizData.title,
            grade: quizData.grade,
            durationMode: quizData.durationMode,
            expireDate: quizData.expireDate,
            totalQuestions: quizData.totalQuestions,
            questionsJson: JSON.stringify(quizData.questions),
            subject: quizData.subject,
            attemptsCount: quizData.attemptsCount || 0,
          }),
        }).catch((err) => console.warn('PostgreSQL quiz sync note:', err));
      }).catch(() => {});
    }

    return quizData;
  },

  deleteQuiz(quizId: string): void {
    addDeletedQuizIds([quizId]);
    inMemoryQuizzes = inMemoryQuizzes.filter((q) => q.id !== quizId);
    try {
      localStorage.setItem(STORAGE_KEYS.QUIZZES, JSON.stringify(inMemoryQuizzes));
    } catch {
      // ignore
    }
    notifyListeners();

    deleteQuizFromFirestore(quizId).catch(() => {});

    if (auth.currentUser) {
      auth.currentUser.getIdToken().then((token) => {
        fetch(`/api/quizzes/${quizId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch((err) => console.warn('PostgreSQL quiz delete note:', err));
      }).catch(() => {});
    }
  },

  reconcileDeletedQuizzes(deletedIds: string[]): void {
    if (!Array.isArray(deletedIds) || deletedIds.length === 0) return;
    const deletedSet = addDeletedQuizIds(deletedIds);
    const next = inMemoryQuizzes.filter((q) => !deletedSet.has(q.id));
    if (next.length !== inMemoryQuizzes.length) {
      inMemoryQuizzes = next;
      try {
        localStorage.setItem(STORAGE_KEYS.QUIZZES, JSON.stringify(inMemoryQuizzes));
      } catch {
        // ignore
      }
      notifyListeners();
    }
  },

  clearAllQuizzes(): void {
    addDeletedQuizIds(inMemoryQuizzes.map((q) => q.id));
    inMemoryQuizzes = [];
    try {
      localStorage.removeItem(STORAGE_KEYS.QUIZZES);
    } catch {
      // ignore
    }
    notifyListeners();
  },

  recordAttempt(quizId: string): void {
    const q = inMemoryQuizzes.find((item) => item.id === quizId);
    if (q) {
      q.attemptsCount = (q.attemptsCount || 0) + 1;
      try {
        localStorage.setItem(STORAGE_KEYS.QUIZZES, JSON.stringify(inMemoryQuizzes));
      } catch {
        // ignore
      }
      notifyListeners();
      recordQuizAttemptInFirestore(quizId, q.attemptsCount).catch(() => {});
    }
  },

  mergeCloudQuizzes(cloudQuizzes: InteractiveQuiz[]): void {
    if (!Array.isArray(cloudQuizzes) || cloudQuizzes.length === 0) return;
    const deletedSet = getDeletedQuizIdSet();
    let changed = false;

    for (const remote of cloudQuizzes) {
      if (!remote?.id || deletedSet.has(remote.id)) continue;
      const idx = inMemoryQuizzes.findIndex((q) => q.id === remote.id);
      if (idx >= 0) {
        const local = inMemoryQuizzes[idx];
        if ((remote.attemptsCount || 0) > (local.attemptsCount || 0)) {
          inMemoryQuizzes[idx] = { ...local, ...remote };
          changed = true;
        }
      } else {
        inMemoryQuizzes.push(remote);
        changed = true;
      }
    }

    if (changed) {
      try {
        localStorage.setItem(STORAGE_KEYS.QUIZZES, JSON.stringify(inMemoryQuizzes));
      } catch {
        // ignore
      }
      notifyListeners();
    }
  },

  syncLocalQuizzesToPublicServer(): void {
    const deletedSet = getDeletedQuizIdSet();
    for (const q of inMemoryQuizzes) {
      if (!q?.id || deletedSet.has(q.id)) continue;
      saveQuizToPublicServer(q).catch(() => {});
    }
  },

  syncLocalQuizzesToFirestore(): void {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const deletedSet = getDeletedQuizIdSet();
    for (const q of inMemoryQuizzes) {
      if (!q?.id || deletedSet.has(q.id)) continue;
      if (!q.userId || q.userId === 'guest_user' || q.userId === uid) {
        if (!q.userId || q.userId === 'guest_user') {
          q.userId = uid;
        }
        saveQuizToFirestore(q).catch(() => {});
      }
    }
  },
};

