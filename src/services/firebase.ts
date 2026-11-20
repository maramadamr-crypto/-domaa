import { initializeApp, deleteApp, FirebaseApp } from 'firebase/app';
import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  signOut, 
  onAuthStateChanged,
  User 
} from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  getDocFromServer, 
  setDoc, 
  updateDoc,
  getDoc, 
  getDocs, 
  deleteDoc, 
  collection, 
  onSnapshot, 
  query, 
  where 
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { StudyDocument, StudyReminder, UserProfile, DocumentQuickNote, VideoItem, InteractiveQuiz, InteractiveComment } from '../types';
import { ensurePdfPageRendered, renderPdfPageForCloudUpload } from './fileProcessor';

export interface FirebaseSettingsConfig {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId: string;
  storageBucket: string;
  messagingSenderId: string;
  isCustom?: boolean;
}

const CUSTOM_FIREBASE_CONFIG_KEY = 'qalami_firebase_custom_config';
const firebaseConfigListeners: Array<() => void> = [];

function notifyFirebaseConfigListeners() {
  firebaseConfigListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      // ignore
    }
  });
}

export function subscribeFirebaseConfig(listener: () => void): () => void {
  firebaseConfigListeners.push(listener);
  return () => {
    const idx = firebaseConfigListeners.indexOf(listener);
    if (idx >= 0) firebaseConfigListeners.splice(idx, 1);
  };
}

export function getFirebaseSettings(): FirebaseSettingsConfig {
  const base: FirebaseSettingsConfig = {
    projectId: firebaseConfig.projectId || '',
    appId: firebaseConfig.appId || '',
    apiKey: firebaseConfig.apiKey || '',
    authDomain: firebaseConfig.authDomain || '',
    firestoreDatabaseId: firebaseConfig.firestoreDatabaseId || '(default)',
    storageBucket: firebaseConfig.storageBucket || '',
    messagingSenderId: firebaseConfig.messagingSenderId || '',
    isCustom: false,
  };

  if (typeof window === 'undefined') return base;

  try {
    const raw = localStorage.getItem(CUSTOM_FIREBASE_CONFIG_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.apiKey === 'string' && parsed.apiKey.trim() && typeof parsed.projectId === 'string' && parsed.projectId.trim()) {
      return {
        projectId: parsed.projectId.trim(),
        appId: (parsed.appId || '').trim(),
        apiKey: parsed.apiKey.trim(),
        authDomain: (parsed.authDomain || `${parsed.projectId.trim()}.firebaseapp.com`).trim(),
        firestoreDatabaseId: (parsed.firestoreDatabaseId || '(default)').trim() || '(default)',
        storageBucket: (parsed.storageBucket || `${parsed.projectId.trim()}.firebasestorage.app`).trim(),
        messagingSenderId: (parsed.messagingSenderId || '').trim(),
        isCustom: true,
      };
    }
  } catch {
    // ignore invalid custom config
  }
  return base;
}

export function isFirebaseConfigured(): boolean {
  const cfg = getFirebaseSettings();
  return Boolean(cfg.apiKey && cfg.projectId);
}

const activeSettings = getFirebaseSettings();

// Initialize Firebase
const app = initializeApp({
  apiKey: activeSettings.apiKey,
  authDomain: activeSettings.authDomain,
  projectId: activeSettings.projectId,
  storageBucket: activeSettings.storageBucket,
  messagingSenderId: activeSettings.messagingSenderId,
  appId: activeSettings.appId,
});
export const db =
  activeSettings.firestoreDatabaseId && activeSettings.firestoreDatabaseId !== '(default)'
    ? getFirestore(app, activeSettings.firestoreDatabaseId)
    : getFirestore(app);
export const auth = getAuth(app);

// Google Auth Provider
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Test Firestore Connection on startup as mandated by skill
export async function testConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
    return false;
  }
}
testConnection();

export function parseFirebaseConfigSnippet(raw: string): Partial<FirebaseSettingsConfig> | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const extractField = (key: string): string => {
    const regex = new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']+)["']`, 'i');
    const match = trimmed.match(regex);
    return match?.[1]?.trim() || '';
  };

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      return {
        projectId: String(parsed.projectId || '').trim(),
        apiKey: String(parsed.apiKey || '').trim(),
        authDomain: String(parsed.authDomain || '').trim(),
        appId: String(parsed.appId || '').trim(),
        firestoreDatabaseId: String(parsed.firestoreDatabaseId || '(default)').trim() || '(default)',
        storageBucket: String(parsed.storageBucket || '').trim(),
        messagingSenderId: String(parsed.messagingSenderId || '').trim(),
      };
    }
  } catch {
    // Fallback to regex parsing for JS object snippet (const firebaseConfig = { ... })
  }

  const projectId = extractField('projectId');
  const apiKey = extractField('apiKey');
  if (!projectId && !apiKey) return null;

  return {
    projectId,
    apiKey,
    authDomain: extractField('authDomain'),
    appId: extractField('appId'),
    firestoreDatabaseId: extractField('firestoreDatabaseId') || '(default)',
    storageBucket: extractField('storageBucket'),
    messagingSenderId: extractField('messagingSenderId'),
  };
}

export async function testFirebaseConnection(
  candidate?: Partial<FirebaseSettingsConfig>
): Promise<{ success: boolean; message: string; latencyMs?: number }> {
  const startedAt = Date.now();
  const current = getFirebaseSettings();
  const target: FirebaseSettingsConfig = {
    ...current,
    ...candidate,
    projectId: (candidate?.projectId ?? current.projectId).trim(),
    apiKey: (candidate?.apiKey ?? current.apiKey).trim(),
    authDomain: (candidate?.authDomain ?? current.authDomain).trim(),
    appId: (candidate?.appId ?? current.appId).trim(),
    firestoreDatabaseId: (candidate?.firestoreDatabaseId ?? current.firestoreDatabaseId).trim() || '(default)',
    storageBucket: (candidate?.storageBucket ?? current.storageBucket).trim(),
    messagingSenderId: (candidate?.messagingSenderId ?? current.messagingSenderId).trim(),
  };

  if (!target.projectId) {
    return { success: false, message: 'يرجى إدخال معرّف المشروع (Project ID)' };
  }
  if (!target.apiKey) {
    return { success: false, message: 'يرجى إدخال مفتاح الواجهة (API Key)' };
  }

  const sameAsActive =
    target.projectId === current.projectId &&
    target.apiKey === current.apiKey &&
    target.firestoreDatabaseId === current.firestoreDatabaseId;

  if (sameAsActive) {
    try {
      await getDocFromServer(doc(db, 'test', 'connection'));
      return {
        success: true,
        latencyMs: Date.now() - startedAt,
        message: `تم الاتصال بخادم Firebase (${target.projectId}) بنجاح! ✅`,
      };
    } catch (err: any) {
      const msg = String(err?.message || '');
      if (msg.includes('permission') || msg.includes('PERMISSION_DENIED')) {
        return {
          success: true,
          latencyMs: Date.now() - startedAt,
          message: `الخادم متصل والمفاتيح صالحة لمشروع (${target.projectId}) ✅`,
        };
      }
      return {
        success: false,
        message: 'تعذر الوصول إلى خادم Firestore. تأكد من الاتصال بالإنترنت وإعدادات المشروع.',
      };
    }
  }

  let tempApp: FirebaseApp | null = null;
  try {
    tempApp = initializeApp(
      {
        apiKey: target.apiKey,
        authDomain: target.authDomain || `${target.projectId}.firebaseapp.com`,
        projectId: target.projectId,
        storageBucket: target.storageBucket || `${target.projectId}.firebasestorage.app`,
        messagingSenderId: target.messagingSenderId,
        appId: target.appId,
      },
      `firebase_probe_${Date.now()}`
    );
    const tempDb =
      target.firestoreDatabaseId && target.firestoreDatabaseId !== '(default)'
        ? getFirestore(tempApp, target.firestoreDatabaseId)
        : getFirestore(tempApp);
    await getDocFromServer(doc(tempDb, 'test', 'connection'));
    return {
      success: true,
      latencyMs: Date.now() - startedAt,
      message: `تم الاتصال بمشروع Firebase (${target.projectId}) بنجاح! ✅`,
    };
  } catch (err: any) {
    const code = String(err?.code || '');
    const msg = String(err?.message || '');
    if (code.includes('permission-denied') || msg.includes('PERMISSION_DENIED')) {
      return {
        success: true,
        latencyMs: Date.now() - startedAt,
        message: `الخادم متصل بمشروع (${target.projectId}) بنجاح! ✅`,
      };
    }
    if (msg.includes('offline')) {
      return {
        success: false,
        message: 'تعذر الاتصال بخادم المشروع (قد يكون معرّف المشروع أو قاعدة البيانات غير صحيح أو الجهاز غير متصل).',
      };
    }
    return {
      success: false,
      message: `تعذر التحقق من إعدادات Firebase: ${msg || 'خطأ غير متوقع'}`,
    };
  } finally {
    if (tempApp) {
      await deleteApp(tempApp).catch(() => {});
    }
  }
}

export async function saveFirebaseSettings(
  settings: Partial<FirebaseSettingsConfig>
): Promise<{ success: boolean; message: string; needsReload?: boolean }> {
  const projectId = (settings.projectId || '').trim();
  const apiKey = (settings.apiKey || '').trim();
  const authDomain = (settings.authDomain || (projectId ? `${projectId}.firebaseapp.com` : '')).trim();
  const appId = (settings.appId || '').trim();
  const firestoreDatabaseId = (settings.firestoreDatabaseId || '(default)').trim() || '(default)';
  const storageBucket = (settings.storageBucket || (projectId ? `${projectId}.firebasestorage.app` : '')).trim();
  const messagingSenderId = (settings.messagingSenderId || '').trim();

  if (!projectId) {
    return { success: false, message: 'يرجى إدخال معرّف مشروع Firebase (Project ID)' };
  }
  if (!apiKey) {
    return { success: false, message: 'يرجى إدخال مفتاح API Key الخاص بـ Firebase' };
  }

  const matchesDefault =
    projectId === firebaseConfig.projectId &&
    apiKey === firebaseConfig.apiKey &&
    firestoreDatabaseId === (firebaseConfig.firestoreDatabaseId || '(default)');

  const previous = getFirebaseSettings();
  const changed =
    projectId !== previous.projectId ||
    apiKey !== previous.apiKey ||
    firestoreDatabaseId !== previous.firestoreDatabaseId ||
    appId !== previous.appId;

  if (matchesDefault) {
    localStorage.removeItem(CUSTOM_FIREBASE_CONFIG_KEY);
  } else {
    localStorage.setItem(
      CUSTOM_FIREBASE_CONFIG_KEY,
      JSON.stringify({
        projectId,
        apiKey,
        authDomain,
        appId,
        firestoreDatabaseId,
        storageBucket,
        messagingSenderId,
      })
    );
  }

  notifyFirebaseConfigListeners();

  return {
    success: true,
    needsReload: changed,
    message: changed
      ? 'تم حفظ إعدادات Firebase الجديدة بنجاح! جاري تحديث الاتصال... 🔥'
      : 'تم تأكيد وحفظ إعدادات Firebase بنجاح! 🔥',
  };
}

export function resetFirebaseSettingsToDefault(): { needsReload: boolean } {
  const hadCustom = typeof window !== 'undefined' && Boolean(localStorage.getItem(CUSTOM_FIREBASE_CONFIG_KEY));
  if (typeof window !== 'undefined') {
    localStorage.removeItem(CUSTOM_FIREBASE_CONFIG_KEY);
  }
  notifyFirebaseConfigListeners();
  return { needsReload: hadCustom };
}

// Standardized Firestore Error Handler
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map((provider) => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Authentication Helpers
export async function signInWithGoogle(): Promise<User | null> {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    if (result.user) {
      await syncUserProfile(result.user);
    }
    return result.user;
  } catch (error) {
    console.error('Google Sign In Error:', error);
    throw error;
  }
}

// Email & Password Authentication
export async function signInWithEmail(email: string, pass: string): Promise<User> {
  const result = await signInWithEmailAndPassword(auth, email, pass);
  if (result.user) {
    await syncUserProfile(result.user);
  }
  return result.user;
}

export async function signUpWithEmail(
  email: string, 
  pass: string, 
  displayName: string,
  role: 'student' | 'teacher' | 'parent' = 'student',
  grade: string = 'الصف الخامس الابتدائي'
): Promise<User> {
  const result = await createUserWithEmailAndPassword(auth, email, pass);
  if (result.user) {
    await updateProfile(result.user, {
      displayName: displayName.trim() || 'طالب متميز',
    });
    // Create initial Firestore profile
    await syncUserProfile(result.user, { role, grade });
  }
  return result.user;
}

export async function logOut(): Promise<void> {
  try {
    await signOut(auth);
  } catch (error) {
    console.error('Sign out error:', error);
    throw error;
  }
}

// User Profile Sync & Edit
export async function syncUserProfile(
  user: User, 
  extras?: Partial<UserProfile>
): Promise<UserProfile> {
  const userPath = `users/${user.uid}`;
  try {
    const profileRef = doc(db, 'users', user.uid);
    const existingSnap = await getDoc(profileRef);
    
    if (existingSnap.exists()) {
      const existingData = existingSnap.data() as UserProfile;
      if (extras && Object.keys(extras).length > 0) {
        const merged = {
          ...existingData,
          ...extras,
          updatedAt: new Date().toISOString(),
        };
        await setDoc(profileRef, merged, { merge: true });
        return merged;
      }
      return existingData;
    }

    const newProfile: UserProfile & { email?: string; createdAt?: string; updatedAt?: string } = {
      id: user.uid,
      name: user.displayName || extras?.name || 'طالب متميز',
      email: user.email || '',
      photoURL: user.photoURL || extras?.photoURL || '',
      role: extras?.role || 'student',
      grade: extras?.grade || 'الصف الخامس الابتدائي',
      avatarColor: extras?.avatarColor || 'from-amber-500 to-orange-600',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await setDoc(profileRef, newProfile);

    // Asynchronously synchronize with PostgreSQL / Cloud SQL database
    user.getIdToken().then((token) => {
      fetch('/api/sync-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          displayName: newProfile.name,
          photoURL: newProfile.photoURL,
        }),
      }).catch((err) => console.warn('PostgreSQL user sync note:', err));
    }).catch(() => {});

    return newProfile;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }
}

export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  try {
    const profileRef = doc(db, 'users', userId);
    const snap = await getDoc(profileRef);
    if (snap.exists()) {
      return snap.data() as UserProfile;
    }
    return null;
  } catch {
    return null;
  }
}

export async function updateAccountProfile(data: {
  name: string;
  photoURL?: string;
  role?: 'student' | 'teacher' | 'parent';
  grade?: string;
  bio?: string;
  avatarColor?: string;
}): Promise<UserProfile | null> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('يجب تسجيل الدخول أولاً لتعديل الحساب');
  }

  // Update Firebase Auth profile
  try {
    await updateProfile(user, {
      displayName: data.name,
      photoURL: data.photoURL || user.photoURL,
    });
  } catch (err) {
    console.warn('Auth updateProfile note:', err);
  }

  // Update Firestore user document
  const userRef = doc(db, 'users', user.uid);
  const updatedData: Partial<UserProfile> = {
    id: user.uid,
    name: data.name,
    photoURL: data.photoURL !== undefined ? data.photoURL : user.photoURL || '',
    role: data.role || 'student',
    grade: data.grade || 'الصف الخامس الابتدائي',
    bio: data.bio || '',
    avatarColor: data.avatarColor || 'from-amber-500 to-orange-600',
    updatedAt: new Date().toISOString(),
  };

  try {
    await setDoc(userRef, updatedData, { merge: true });
  } catch (err) {
    console.warn('Firestore user update note:', err);
  }

  return updatedData as UserProfile;
}

// Helper to keep Firestore strings safely under size limits
function buildSafeAnnotationsJson(document: StudyDocument): string {
  try {
    const compact = (document.pages || [])
      .filter((p) => (p.annotations && p.annotations.length > 0))
      .map((p) => ({
        id: p.id,
        pageNumber: p.pageNumber,
        annotations: p.annotations,
      }));
    if (compact.length === 0) return '';
    const json = JSON.stringify(compact);
    return json.length <= 340000 ? json : '';
  } catch {
    return '';
  }
}

export function isRealImageUrl(url?: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('data:image/svg+xml')) return false;
  if (trimmed === 'data:,' || (trimmed.startsWith('data:') && trimmed.length < 100)) return false;
  return true;
}

async function compressDataUrlForCloud(
  dataUrl: string,
  maxDimension: number = 1280,
  maxLength: number = 520000
): Promise<string> {
  if (!isRealImageUrl(dataUrl)) return '';
  if (!dataUrl.startsWith('data:')) {
    return dataUrl.length <= 740000 ? dataUrl : '';
  }
  if (dataUrl.length <= maxLength) {
    return dataUrl;
  }
  if (typeof document === 'undefined') return '';

  const renderResized = (img: HTMLImageElement, maxDim: number, quality: number): string => {
    let width = img.naturalWidth || img.width || 800;
    let height = img.naturalHeight || img.height || 1130;
    if (width > maxDim || height > maxDim) {
      const ratio = Math.min(maxDim / width, maxDim / height);
      width = Math.max(1, Math.round(width * ratio));
      height = Math.max(1, Math.round(height * ratio));
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return '';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const out = canvas.toDataURL('image/jpeg', quality);
    canvas.width = 0;
    canvas.height = 0;
    return out;
  };

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const steps = [
          { dim: maxDimension, q: 0.78 },
          { dim: maxDimension, q: 0.64 },
          { dim: Math.min(maxDimension, 1024), q: 0.54 },
          { dim: Math.min(maxDimension, 860), q: 0.46 },
          { dim: Math.min(maxDimension, 700), q: 0.38 },
          { dim: 560, q: 0.32 },
        ];
        const hardCap = Math.min(Math.max(maxLength, 680000), 735000);
        let bestOut = '';
        for (const step of steps) {
          const out = renderResized(img, step.dim, step.q);
          if (isRealImageUrl(out)) {
            bestOut = out;
            if (out.length <= maxLength) {
              resolve(out);
              return;
            }
            if (out.length <= hardCap && step.dim <= 860) {
              resolve(out);
              return;
            }
          }
        }
        resolve(bestOut.length <= hardCap ? bestOut : '');
      } catch {
        resolve('');
      }
    };
    img.onerror = () => resolve('');
    img.src = dataUrl;
  });
}

async function buildCoverThumbnail(dataUrl: string): Promise<string> {
  if (!isRealImageUrl(dataUrl)) return '';
  const compressed = await compressDataUrlForCloud(dataUrl, 480, 180000);
  return compressed.length <= 245000 ? compressed : '';
}

export function parseRemoteDocumentSnap(data: any): Partial<StudyDocument> {
  const reconstructedPages: StudyDocument['pages'] = [];
  const totalPages = Math.max(1, Number(data.pageCount) || 1);
  const annotationMap = new Map<number, any[]>();

  if (typeof data.annotationsJson === 'string' && data.annotationsJson) {
    try {
      const parsed = JSON.parse(data.annotationsJson);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.pageNumber === 'number') {
            annotationMap.set(item.pageNumber, Array.isArray(item.annotations) ? item.annotations : []);
          }
        }
      }
    } catch {
      // ignore malformed annotationsJson
    }
  }

  const coverImg = typeof data.coverImageUrl === 'string' ? data.coverImageUrl : '';

  for (let p = 1; p <= Math.min(totalPages, 5000); p++) {
    reconstructedPages.push({
      id: `${data.id}_p${p}`,
      pageNumber: p,
      imageUrl: p === 1 && isRealImageUrl(coverImg) ? coverImg : '',
      annotations: annotationMap.get(p) || [],
      lastEdited: Date.now(),
    });
  }

  return {
    id: data.id,
    title: data.title,
    subject: data.subject,
    customSubjectName: data.customSubjectName || '',
    docType: data.docType,
    format: data.format || 'files',
    grade: data.grade,
    term: data.term,
    author: data.author,
    description: data.description || '',
    userId: data.userId,
    averageRating: data.averageRating ?? 5,
    ratingsCount: data.ratingsCount ?? 0,
    comments: Array.isArray(data.comments) ? data.comments : [],
    bookmarks: Array.isArray(data.bookmarks) ? data.bookmarks : [],
    tags: Array.isArray(data.tags) ? data.tags : [],
    pages: reconstructedPages,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}

// Public Shared Relay Helpers (Works across any device/browser without email login)
async function saveDocumentMetaToPublicServer(cloudDoc: any): Promise<boolean> {
  if (typeof fetch === 'undefined') return false;
  try {
    const res = await fetch('/api/public-documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cloudDoc),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function uploadPagesBatchToPublicServer(
  docId: string,
  pages: Array<{ pageNumber: number; imageUrl: string; annotationsJson: string }>
): Promise<boolean> {
  if (typeof fetch === 'undefined' || pages.length === 0) return false;
  try {
    const res = await fetch(`/api/public-documents/${encodeURIComponent(docId)}/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchPublicDocumentsWithDeletions(): Promise<{
  documents: Partial<StudyDocument>[];
  deletedDocIds: string[];
}> {
  if (typeof fetch === 'undefined') return { documents: [], deletedDocIds: [] };
  try {
    const res = await fetch('/api/public-documents');
    if (!res.ok) return { documents: [], deletedDocIds: [] };
    const data = await res.json();
    const documents = Array.isArray(data?.documents)
      ? data.documents.map((d: any) => parseRemoteDocumentSnap(d))
      : [];
    const deletedDocIds = Array.isArray(data?.deletedDocIds)
      ? data.deletedDocIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : [];
    return { documents, deletedDocIds };
  } catch {
    return { documents: [], deletedDocIds: [] };
  }
}

export async function fetchDocumentsFromPublicServer(): Promise<Partial<StudyDocument>[]> {
  const res = await fetchPublicDocumentsWithDeletions();
  return res.documents;
}

export interface PublicSyncState {
  videos: VideoItem[];
  deletedVideoIds: string[];
  quizzes: InteractiveQuiz[];
  deletedQuizIds: string[];
  comments: InteractiveComment[];
  deletedCommentIds: string[];
  deletedReminderIds: string[];
}

export async function fetchPublicSyncState(): Promise<PublicSyncState> {
  const empty: PublicSyncState = {
    videos: [],
    deletedVideoIds: [],
    quizzes: [],
    deletedQuizIds: [],
    comments: [],
    deletedCommentIds: [],
    deletedReminderIds: [],
  };
  if (typeof fetch === 'undefined') return empty;
  try {
    const res = await fetch('/api/public-sync');
    if (!res.ok) return empty;
    const data = await res.json();
    if (!data?.success) return empty;
    return {
      videos: Array.isArray(data.videos) ? data.videos : [],
      deletedVideoIds: Array.isArray(data.deletedVideoIds) ? data.deletedVideoIds : [],
      quizzes: Array.isArray(data.quizzes) ? data.quizzes : [],
      deletedQuizIds: Array.isArray(data.deletedQuizIds) ? data.deletedQuizIds : [],
      comments: Array.isArray(data.comments) ? data.comments : [],
      deletedCommentIds: Array.isArray(data.deletedCommentIds) ? data.deletedCommentIds : [],
      deletedReminderIds: Array.isArray(data.deletedReminderIds) ? data.deletedReminderIds : [],
    };
  } catch {
    return empty;
  }
}

export async function saveVideoToPublicServer(video: VideoItem): Promise<void> {
  if (typeof fetch === 'undefined' || !video?.id) return;
  try {
    await fetch('/api/public-videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(video),
    });
  } catch {
    // ignore
  }
}

export async function deleteVideoFromPublicServer(videoId: string): Promise<void> {
  if (typeof fetch === 'undefined' || !videoId) return;
  try {
    await fetch(`/api/public-videos/${encodeURIComponent(videoId)}`, { method: 'DELETE' });
  } catch {
    // ignore
  }
}

export async function saveQuizToPublicServer(quiz: InteractiveQuiz): Promise<void> {
  if (typeof fetch === 'undefined' || !quiz?.id) return;
  try {
    await fetch('/api/public-quizzes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(quiz),
    });
  } catch {
    // ignore
  }
}

export async function deleteQuizFromPublicServer(quizId: string): Promise<void> {
  if (typeof fetch === 'undefined' || !quizId) return;
  try {
    await fetch(`/api/public-quizzes/${encodeURIComponent(quizId)}`, { method: 'DELETE' });
  } catch {
    // ignore
  }
}

export async function saveCommentToPublicServer(comment: InteractiveComment): Promise<void> {
  if (typeof fetch === 'undefined' || !comment?.id) return;
  try {
    await fetch('/api/public-comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(comment),
    });
  } catch {
    // ignore
  }
}

export async function deleteCommentFromPublicServer(commentId: string, targetId?: string): Promise<void> {
  if (typeof fetch === 'undefined' || !commentId) return;
  try {
    const qs = targetId ? `?targetId=${encodeURIComponent(targetId)}` : '';
    await fetch(`/api/public-comments/${encodeURIComponent(commentId)}${qs}`, { method: 'DELETE' });
  } catch {
    // ignore
  }
}

export async function deleteReminderFromPublicServer(reminderId: string): Promise<void> {
  if (typeof fetch === 'undefined' || !reminderId) return;
  try {
    await fetch(`/api/public-reminders/${encodeURIComponent(reminderId)}`, { method: 'DELETE' });
  } catch {
    // ignore
  }
}

async function fetchDocumentPageFromPublicServer(
  docId: string,
  pageNumber: number
): Promise<{ pageNumber: number; imageUrl: string; annotations?: any[] } | null> {
  if (typeof fetch === 'undefined') return null;
  try {
    const res = await fetch(`/api/public-documents/${encodeURIComponent(docId)}/pages/${pageNumber}`);
    if (!res.ok) return null;
    const data = await res.json();
    const p = data?.page;
    if (!p || !isRealImageUrl(p.imageUrl)) return null;
    let annotations: any[] | undefined;
    if (typeof p.annotationsJson === 'string' && p.annotationsJson) {
      try {
        const parsed = JSON.parse(p.annotationsJson);
        if (Array.isArray(parsed)) annotations = parsed;
      } catch {
        // ignore
      }
    }
    return {
      pageNumber: Number(p.pageNumber) || pageNumber,
      imageUrl: p.imageUrl,
      annotations,
    };
  } catch {
    return null;
  }
}

async function fetchDocumentPagesRangeFromPublicServer(
  docId: string,
  pageNumbers: number[]
): Promise<Array<{ pageNumber: number; imageUrl: string; annotations?: any[] }>> {
  if (typeof fetch === 'undefined' || pageNumbers.length === 0) return [];
  try {
    const res = await fetch(
      `/api/public-documents/${encodeURIComponent(docId)}/pages?nums=${pageNumbers.join(',')}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data?.pages)) return [];
    return data.pages
      .filter((p: any) => p && isRealImageUrl(p.imageUrl))
      .map((p: any) => {
        let annotations: any[] | undefined;
        if (typeof p.annotationsJson === 'string' && p.annotationsJson) {
          try {
            const parsed = JSON.parse(p.annotationsJson);
            if (Array.isArray(parsed)) annotations = parsed;
          } catch {
            // ignore
          }
        }
        return {
          pageNumber: Number(p.pageNumber) || 1,
          imageUrl: p.imageUrl,
          annotations,
        };
      });
  } catch {
    return [];
  }
}

async function deleteDocumentFromPublicServer(docId: string): Promise<void> {
  if (typeof fetch === 'undefined') return;
  try {
    await fetch(`/api/public-documents/${encodeURIComponent(docId)}`, { method: 'DELETE' });
  } catch {
    // ignore
  }
}

const uploadedDocumentPageCounts = new Map<string, number>();
const inFlightPageUploads = new Map<string, Promise<void>>();

export async function syncDocumentPagesToFirestore(
  documentItem: StudyDocument,
  options?: { checkExistingFirst?: boolean; force?: boolean }
): Promise<void> {
  const uid = auth.currentUser?.uid || '';
  const isSignedIn = Boolean(uid);
  const pages = documentItem.pages || [];
  if (pages.length === 0) return;

  const uploadKey = `${isSignedIn ? 'fb' : 'pub'}_${documentItem.id}`;
  if (!options?.force && uploadedDocumentPageCounts.get(uploadKey) === pages.length) {
    return;
  }

  const existingTask = inFlightPageUploads.get(uploadKey);
  if (existingTask && !options?.force) {
    return existingTask;
  }

  const task = (async () => {
    const totalPages = pages.length;
    try {
      const hasAnyLocalPageSource =
        Boolean(documentItem.pdfFileId) || pages.some((p) => isRealImageUrl(p.imageUrl));
      if (!hasAnyLocalPageSource) return;

      // Skip re-uploading only if first, middle, and last pages already exist cleanly
      if (options?.checkExistingFirst && !options?.force) {
        try {
          const midNum = Math.max(1, Math.ceil(totalPages / 2));
          const lastNum = pages[totalPages - 1]?.pageNumber || totalPages;
          const probeNums = Array.from(new Set([1, midNum, lastNum]));

          const pubProbe = await fetchDocumentPagesRangeFromPublicServer(documentItem.id, probeNums);
          const pubHasAll = probeNums.every((n) => pubProbe.some((rp) => rp.pageNumber === n && isRealImageUrl(rp.imageUrl)));

          let fbHasAll = !isSignedIn;
          if (isSignedIn) {
            const fbSnaps = await Promise.all(
              probeNums.map((n) => getDoc(doc(db, 'documents', documentItem.id, 'pages', `p_${n}`)))
            );
            fbHasAll = fbSnaps.every((s) => s.exists() && isRealImageUrl(s.data()?.imageUrl));
          }

          if (pubHasAll && fbHasAll) {
            uploadedDocumentPageCounts.set(uploadKey, totalPages);
            return;
          }
        } catch {
          // Proceed with upload
        }
      }

      const nowIso = new Date().toISOString();
      const batchSize = 8;
      let succeededCount = 0;

      for (let i = 0; i < pages.length; i += batchSize) {
        const batch = pages.slice(i, i + batchSize);
        const publicBatchPayload: Array<{ pageNumber: number; imageUrl: string; annotationsJson: string }> = [];

        await Promise.all(
          batch.map(async (page) => {
            try {
              let rawImg = isRealImageUrl(page.imageUrl) ? page.imageUrl : '';
              if (!rawImg && documentItem.pdfFileId) {
                rawImg = await renderPdfPageForCloudUpload(documentItem.pdfFileId, page.pageNumber, 1.05);
              }
              if (!isRealImageUrl(rawImg)) return;

              const compressedImg = await compressDataUrlForCloud(rawImg, 1280, 520000);
              if (!isRealImageUrl(compressedImg)) return;

              const annotationsJson = (() => {
                try {
                  if (!page.annotations || page.annotations.length === 0) return '';
                  const s = JSON.stringify(page.annotations);
                  return s.length <= 145000 ? s : '';
                } catch {
                  return '';
                }
              })();

              publicBatchPayload.push({
                pageNumber: page.pageNumber,
                imageUrl: compressedImg,
                annotationsJson,
              });

              if (isSignedIn) {
                const pageId = `p_${page.pageNumber}`;
                const pageRef = doc(db, 'documents', documentItem.id, 'pages', pageId);
                await setDoc(
                  pageRef,
                  {
                    id: pageId,
                    docId: documentItem.id,
                    userId: uid,
                    pageNumber: page.pageNumber,
                    imageUrl: compressedImg,
                    annotationsJson,
                    updatedAt: nowIso,
                  },
                  { merge: true }
                );
              }
              succeededCount++;
            } catch (pageErr) {
              console.warn(`Page ${page.pageNumber} sync note:`, pageErr);
            }
          })
        );

        if (publicBatchPayload.length > 0) {
          await uploadPagesBatchToPublicServer(documentItem.id, publicBatchPayload);
        }

        if (i + batchSize < pages.length && pages.length > 24) {
          await new Promise((r) => setTimeout(r, 5));
        }
      }

      if (succeededCount === totalPages) {
        uploadedDocumentPageCounts.set(uploadKey, totalPages);
      }
    } finally {
      inFlightPageUploads.delete(uploadKey);
    }
  })();

  inFlightPageUploads.set(uploadKey, task);
  return task;
}

export async function fetchDocumentPageFromFirestore(
  docId: string,
  pageNumber: number
): Promise<{ pageNumber: number; imageUrl: string; annotations?: any[] } | null> {
  // 1. Try Firestore first (supports custom/permanent cloud storage)
  try {
    const snap = await getDoc(doc(db, 'documents', docId, 'pages', `p_${pageNumber}`));
    if (snap.exists()) {
      const d = snap.data();
      if (isRealImageUrl(d.imageUrl)) {
        let annotations: any[] | undefined;
        if (typeof d.annotationsJson === 'string' && d.annotationsJson) {
          try {
            const parsed = JSON.parse(d.annotationsJson);
            if (Array.isArray(parsed)) annotations = parsed;
          } catch {
            // ignore
          }
        }
        return {
          pageNumber: Number(d.pageNumber) || pageNumber,
          imageUrl: d.imageUrl,
          annotations,
        };
      }
    }
  } catch (error) {
    console.warn(`Firestore page ${pageNumber} fetch note:`, error);
  }

  // 2. Fallback to Public Shared Server Relay (works even if publisher had 0 email login)
  return fetchDocumentPageFromPublicServer(docId, pageNumber);
}

export async function fetchDocumentPagesBatchFromCloud(
  docId: string,
  pageNumbers: number[]
): Promise<Array<{ pageNumber: number; imageUrl: string; annotations?: any[] }>> {
  const uniqueNums = Array.from(new Set(pageNumbers.filter((n) => n >= 1 && n <= 5000)));
  if (uniqueNums.length === 0) return [];

  const resultMap = new Map<number, { pageNumber: number; imageUrl: string; annotations?: any[] }>();

  // 1. Fast single-roundtrip fetch from public shared server
  const serverPages = await fetchDocumentPagesRangeFromPublicServer(docId, uniqueNums);
  for (const sp of serverPages) {
    if (isRealImageUrl(sp.imageUrl)) {
      resultMap.set(sp.pageNumber, sp);
    }
  }

  // 2. For any remaining missing pages, query Firestore directly by exact doc ID
  const stillMissing = uniqueNums.filter((n) => !resultMap.has(n));
  if (stillMissing.length > 0) {
    await Promise.all(
      stillMissing.map(async (num) => {
        try {
          const snap = await getDoc(doc(db, 'documents', docId, 'pages', `p_${num}`));
          if (!snap.exists()) return;
          const d = snap.data();
          if (!isRealImageUrl(d.imageUrl)) return;
          let annotations: any[] | undefined;
          if (typeof d.annotationsJson === 'string' && d.annotationsJson) {
            try {
              const parsed = JSON.parse(d.annotationsJson);
              if (Array.isArray(parsed)) annotations = parsed;
            } catch {
              // ignore
            }
          }
          resultMap.set(num, {
            pageNumber: Number(d.pageNumber) || num,
            imageUrl: d.imageUrl,
            annotations,
          });
        } catch {
          // ignore per-page failure
        }
      })
    );
  }

  return Array.from(resultMap.values()).sort((a, b) => a.pageNumber - b.pageNumber);
}

export async function fetchAllDocumentPagesFromFirestore(
  docId: string
): Promise<Array<{ pageNumber: number; imageUrl: string; annotations?: any[] }>> {
  try {
    const snap = await getDocs(collection(db, 'documents', docId, 'pages'));
    const pages: Array<{ pageNumber: number; imageUrl: string; annotations?: any[] }> = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      let annotations: any[] | undefined;
      if (typeof d.annotationsJson === 'string' && d.annotationsJson) {
        try {
          const parsed = JSON.parse(d.annotationsJson);
          if (Array.isArray(parsed)) annotations = parsed;
        } catch {
          // ignore
        }
      }
      if (isRealImageUrl(d.imageUrl)) {
        pages.push({
          pageNumber: Number(d.pageNumber) || 1,
          imageUrl: d.imageUrl,
          annotations,
        });
      }
    });
    pages.sort((a, b) => a.pageNumber - b.pageNumber);
    return pages;
  } catch (error) {
    console.warn('Firestore all pages fetch note:', error);
    return [];
  }
}

// Document Cloud Persistence (Works with BOTH Firebase Auth AND zero-login Public Relay)
export async function saveDocumentToFirestore(
  document: StudyDocument,
  options?: { syncPages?: boolean; checkExistingPagesFirst?: boolean }
): Promise<void> {
  const nowIso = new Date().toISOString();
  const safeAnnotationsJson = buildSafeAnnotationsJson(document);
  const safeBookmarks = Array.isArray(document.bookmarks)
    ? document.bookmarks.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).slice(0, 500)
    : [];
  const safeTags = Array.isArray(document.tags)
    ? document.tags.map((t) => String(t).slice(0, 50)).filter(Boolean).slice(0, 20)
    : [];
  const safePageCount = Math.max(1, Math.min(5000, document.pages?.length || 1));
  const currentUid = auth.currentUser?.uid || document.userId || 'public_publisher';

  // Resolve cover thumbnail from page 1 (or PDF page 1)
  let rawCoverUrl = isRealImageUrl(document.pages?.[0]?.imageUrl)
    ? document.pages[0].imageUrl
    : '';
  if (!rawCoverUrl && document.pdfFileId) {
    try {
      rawCoverUrl = await renderPdfPageForCloudUpload(document.pdfFileId, 1, 1.0);
    } catch {
      rawCoverUrl = '';
    }
  }
  const generatedCoverUrl = rawCoverUrl ? await buildCoverThumbnail(rawCoverUrl) : '';

  const baseCloudDoc = {
    id: document.id,
    title: String(document.title || 'مذكرة دراسية').trim().slice(0, 200) || 'مذكرة دراسية',
    subject: String(document.subject || 'arabic').slice(0, 50),
    customSubjectName: String(document.customSubjectName || '').slice(0, 100),
    docType: String(document.docType || 'booklet').slice(0, 50),
    format: String(document.format || 'files').slice(0, 50),
    grade: String(document.grade || 'الصف الخامس الابتدائي').slice(0, 100),
    term: String(document.term || 'term1').slice(0, 50),
    author: String(document.author || 'طالب').slice(0, 100),
    description: String(document.description || '').slice(0, 2000),
    userId: currentUid,
    averageRating: Number(document.averageRating ?? 5),
    ratingsCount: Number(document.ratingsCount ?? 0),
    comments: (document.comments || []).slice(-15),
    bookmarks: safeBookmarks,
    tags: safeTags,
    pageCount: safePageCount,
    coverImageUrl: generatedCoverUrl,
    annotationsJson: safeAnnotationsJson,
    createdAt: document.createdAt || nowIso,
    updatedAt: nowIso,
  };

  // Always save metadata to the shared cross-device public relay (zero login required)
  saveDocumentMetaToPublicServer(baseCloudDoc).catch(() => {});

  // If NOT signed in with Firebase, run public server page upload immediately and exit
  if (!auth.currentUser) {
    if (options?.syncPages !== false) {
      syncDocumentPagesToFirestore(document, {
        checkExistingFirst: options?.checkExistingPagesFirst ?? false,
      }).catch((err) => console.warn('Document pages background sync note:', err));
    }
    return;
  }

  const docPath = `documents/${document.id}`;
  try {
    const docRef = doc(db, 'documents', document.id);
    const existingSnap = await getDoc(docRef);
    const fbUid = auth.currentUser.uid;

    if (existingSnap.exists()) {
      const existingData = existingSnap.data();
      if (existingData.userId && existingData.userId !== fbUid) {
        await updateDoc(docRef, {
          averageRating: document.averageRating ?? existingData.averageRating ?? 5,
          ratingsCount: document.ratingsCount ?? existingData.ratingsCount ?? 0,
          comments: (document.comments || []).slice(-15),
          updatedAt: nowIso,
        });
        return;
      }

      const finalCoverUrl = generatedCoverUrl || existingData.coverImageUrl || '';
      const cloudDoc = {
        ...baseCloudDoc,
        userId: existingData.userId || fbUid,
        coverImageUrl: finalCoverUrl,
        createdAt: existingData.createdAt || document.createdAt || nowIso,
      };
      await setDoc(docRef, cloudDoc, { merge: true });
    } else {
      await setDoc(docRef, {
        ...baseCloudDoc,
        userId: fbUid,
      });
    }

    // Now that the parent Firestore document exists and is owned by fbUid, upload original pages
    if (options?.syncPages !== false) {
      syncDocumentPagesToFirestore(document, {
        checkExistingFirst: options?.checkExistingPagesFirst ?? false,
      }).catch((err) => console.warn('Document pages background sync note:', err));
    }

    // Sync to PostgreSQL database if enabled
    auth.currentUser.getIdToken().then((token) => {
      fetch('/api/documents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: document.id,
          title: document.title,
          subject: document.subject,
          customSubjectName: document.customSubjectName || '',
          docType: document.docType,
          format: document.format || 'files',
          grade: document.grade,
          term: document.term,
          author: document.author,
          description: document.description || '',
          pagesJson: JSON.stringify(document.pages || []),
          averageRating: document.averageRating ?? 5,
          ratingsCount: document.ratingsCount ?? 0,
        }),
      }).catch((err) => console.warn('PostgreSQL doc sync note:', err));
    }).catch(() => {});
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, docPath);
  }
}

export async function fetchDocumentsFromFirestore(): Promise<Partial<StudyDocument>[]> {
  try {
    const snap = await getDocs(collection(db, 'documents'));
    const docs: Partial<StudyDocument>[] = [];
    snap.forEach((docSnap) => {
      docs.push(parseRemoteDocumentSnap(docSnap.data()));
    });
    return docs;
  } catch (error) {
    console.warn('Firestore documents fetch fallback:', error);
    return [];
  }
}

export function subscribeToFirestoreDocuments(
  onData: (docs: Partial<StudyDocument>[], removedIds?: string[]) => void
): () => void {
  const path = 'documents';
  return onSnapshot(
    collection(db, path),
    (snapshot) => {
      const docs: Partial<StudyDocument>[] = [];
      snapshot.forEach((docSnap) => {
        docs.push(parseRemoteDocumentSnap(docSnap.data()));
      });
      const removedIds = snapshot
        .docChanges()
        .filter((change) => change.type === 'removed')
        .map((change) => change.doc.id);
      onData(docs, removedIds);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export async function deleteDocumentFromFirestore(documentId: string): Promise<void> {
  // Always delete from public relay too
  deleteDocumentFromPublicServer(documentId).catch(() => {});

  if (!auth.currentUser) {
    return;
  }
  const docPath = `documents/${documentId}`;
  try {
    await deleteDoc(doc(db, 'documents', documentId));

    // Delete from PostgreSQL database
    auth.currentUser.getIdToken().then((token) => {
      fetch(`/api/documents/${documentId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      }).catch((err) => console.warn('PostgreSQL doc delete note:', err));
    }).catch(() => {});
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, docPath);
  }
}

// Videos Cloud Persistence (Shorts & Lessons)
function sanitizeCloudUrl(url: string | undefined, maxLen: number): string {
  if (!url || typeof url !== 'string') return '';
  if (url.startsWith('blob:')) return '';
  return url.length <= maxLen ? url : '';
}

export async function saveVideoToFirestore(video: VideoItem): Promise<void> {
  saveVideoToPublicServer(video).catch(() => {});
  if (!auth.currentUser) return;
  const videoPath = `videos/${video.id}`;
  try {
    const videoRef = doc(db, 'videos', video.id);
    const existingSnap = await getDoc(videoRef);
    const nowIso = new Date().toISOString();
    const currentUid = auth.currentUser.uid;

    const payload = {
      id: video.id,
      userId: existingSnap.exists() ? existingSnap.data().userId || currentUid : currentUid,
      author: String(video.author || 'ناشر').slice(0, 100),
      authorPhoto: sanitizeCloudUrl(video.authorPhoto, 195000),
      title: String(video.title || 'فيديو تعليمي').slice(0, 200),
      description: String(video.description || '').slice(0, 2000),
      type: video.type === 'lesson' ? 'lesson' : 'shorts',
      durationSeconds: Math.max(1, Math.round(Number(video.durationSeconds) || 1)),
      videoUrl: sanitizeCloudUrl(video.videoUrl, 295000),
      thumbnailUrl: sanitizeCloudUrl(video.thumbnailUrl, 195000),
      subject: String(video.subject || 'arabic').slice(0, 50),
      grade: String(video.grade || 'الصف الخامس الابتدائي').slice(0, 100),
      likesCount: Math.max(0, Math.round(Number(video.likesCount) || 0)),
      sharesCount: Math.max(0, Math.round(Number(video.sharesCount) || 0)),
      commentsCount: Math.max(0, Math.round(Number(video.commentsCount) || 0)),
      createdAt: existingSnap.exists() ? existingSnap.data().createdAt || video.createdAt || nowIso : video.createdAt || nowIso,
      updatedAt: nowIso,
    };

    if (existingSnap.exists() && existingSnap.data().userId !== currentUid) {
      await updateDoc(videoRef, {
        likesCount: payload.likesCount,
        sharesCount: payload.sharesCount,
        commentsCount: payload.commentsCount,
        updatedAt: nowIso,
      });
    } else {
      await setDoc(videoRef, payload, { merge: true });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, videoPath);
  }
}

export async function updateVideoLikeInFirestore(videoId: string, likesCount: number): Promise<void> {
  if (!auth.currentUser) return;
  const videoPath = `videos/${videoId}`;
  try {
    const videoRef = doc(db, 'videos', videoId);
    const snap = await getDoc(videoRef);
    if (!snap.exists()) return;
    await updateDoc(videoRef, {
      likesCount: Math.max(0, Math.round(likesCount)),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, videoPath);
  }
}

export async function deleteVideoFromFirestore(videoId: string): Promise<void> {
  deleteVideoFromPublicServer(videoId).catch(() => {});
  if (!auth.currentUser) return;
  const videoPath = `videos/${videoId}`;
  try {
    await deleteDoc(doc(db, 'videos', videoId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, videoPath);
  }
}

export async function fetchVideosFromFirestore(): Promise<VideoItem[]> {
  try {
    const snap = await getDocs(collection(db, 'videos'));
    const list: VideoItem[] = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      list.push({
        id: d.id,
        userId: d.userId,
        author: d.author,
        authorPhoto: d.authorPhoto || '',
        title: d.title,
        description: d.description || '',
        type: d.type === 'lesson' ? 'lesson' : 'shorts',
        durationSeconds: Number(d.durationSeconds) || 30,
        videoUrl: d.videoUrl || '',
        thumbnailUrl: d.thumbnailUrl || '',
        subject: d.subject || 'arabic',
        grade: d.grade || 'الصف الخامس الابتدائي',
        likesCount: Number(d.likesCount) || 0,
        sharesCount: Number(d.sharesCount) || 0,
        commentsCount: Number(d.commentsCount) || 0,
        comments: [],
        createdAt: d.createdAt || new Date().toISOString(),
        updatedAt: d.updatedAt || new Date().toISOString(),
      });
    });
    return list;
  } catch (error) {
    console.warn('Firestore videos fetch fallback:', error);
    return [];
  }
}

export function subscribeToFirestoreVideos(
  onData: (videos: VideoItem[], removedIds?: string[]) => void
): () => void {
  const path = 'videos';
  return onSnapshot(
    collection(db, path),
    (snapshot) => {
      const list: VideoItem[] = [];
      snapshot.forEach((docSnap) => {
        const d = docSnap.data();
        list.push({
          id: d.id,
          userId: d.userId,
          author: d.author,
          authorPhoto: d.authorPhoto || '',
          title: d.title,
          description: d.description || '',
          type: d.type === 'lesson' ? 'lesson' : 'shorts',
          durationSeconds: Number(d.durationSeconds) || 30,
          videoUrl: d.videoUrl || '',
          thumbnailUrl: d.thumbnailUrl || '',
          subject: d.subject || 'arabic',
          grade: d.grade || 'الصف الخامس الابتدائي',
          likesCount: Number(d.likesCount) || 0,
          sharesCount: Number(d.sharesCount) || 0,
          commentsCount: Number(d.commentsCount) || 0,
          comments: [],
          createdAt: d.createdAt || new Date().toISOString(),
          updatedAt: d.updatedAt || new Date().toISOString(),
        });
      });
      const removedIds = snapshot
        .docChanges()
        .filter((change) => change.type === 'removed')
        .map((change) => change.doc.id);
      onData(list, removedIds);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

// Quizzes Cloud Persistence
export async function saveQuizToFirestore(quiz: InteractiveQuiz): Promise<void> {
  saveQuizToPublicServer(quiz).catch(() => {});
  if (!auth.currentUser) return;
  const quizPath = `quizzes/${quiz.id}`;
  try {
    const quizRef = doc(db, 'quizzes', quiz.id);
    const existingSnap = await getDoc(quizRef);
    const nowIso = new Date().toISOString();
    const currentUid = auth.currentUser.uid;
    const questionsJson = JSON.stringify(quiz.questions || []).slice(0, 295000);

    if (existingSnap.exists() && existingSnap.data().userId !== currentUid) {
      await updateDoc(quizRef, {
        attemptsCount: Math.max(0, Math.round(Number(quiz.attemptsCount) || 0)),
        updatedAt: nowIso,
      });
      return;
    }

    await setDoc(
      quizRef,
      {
        id: quiz.id,
        userId: existingSnap.exists() ? existingSnap.data().userId || currentUid : currentUid,
        author: String(quiz.author || 'معلم').slice(0, 100),
        title: String(quiz.title || 'اختبار تفاعلي').slice(0, 200),
        grade: String(quiz.grade || 'الصف الخامس الابتدائي').slice(0, 100),
        durationMode: quiz.durationMode === 'temporary' ? 'temporary' : 'always',
        expireDate: quiz.expireDate ? String(quiz.expireDate).slice(0, 50) : '',
        totalQuestions: Math.max(0, Math.round(Number(quiz.totalQuestions ?? quiz.questions?.length ?? 0))),
        questionsJson,
        subject: String(quiz.subject || 'arabic').slice(0, 50),
        attemptsCount: Math.max(0, Math.round(Number(quiz.attemptsCount) || 0)),
        createdAt: existingSnap.exists() ? existingSnap.data().createdAt || quiz.createdAt || nowIso : quiz.createdAt || nowIso,
        updatedAt: nowIso,
      },
      { merge: true }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, quizPath);
  }
}

export async function recordQuizAttemptInFirestore(quizId: string, attemptsCount: number): Promise<void> {
  if (!auth.currentUser) return;
  const quizPath = `quizzes/${quizId}`;
  try {
    const quizRef = doc(db, 'quizzes', quizId);
    const snap = await getDoc(quizRef);
    if (!snap.exists()) return;
    await updateDoc(quizRef, {
      attemptsCount: Math.max(0, Math.round(attemptsCount)),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, quizPath);
  }
}

export async function deleteQuizFromFirestore(quizId: string): Promise<void> {
  deleteQuizFromPublicServer(quizId).catch(() => {});
  if (!auth.currentUser) return;
  const quizPath = `quizzes/${quizId}`;
  try {
    await deleteDoc(doc(db, 'quizzes', quizId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, quizPath);
  }
}

function parseRemoteQuiz(d: any): InteractiveQuiz {
  let parsedQuestions: any[] = [];
  if (typeof d.questionsJson === 'string' && d.questionsJson) {
    try {
      const res = JSON.parse(d.questionsJson);
      if (Array.isArray(res)) parsedQuestions = res;
    } catch {
      parsedQuestions = [];
    }
  }
  return {
    id: d.id,
    userId: d.userId,
    author: d.author,
    title: d.title,
    grade: d.grade || 'الصف الخامس الابتدائي',
    durationMode: d.durationMode === 'temporary' || d.durationMode === 'timed' ? 'temporary' : 'always',
    expireDate: d.expireDate || undefined,
    totalQuestions: Number(d.totalQuestions) || parsedQuestions.length,
    questions: parsedQuestions,
    subject: d.subject || 'arabic',
    attemptsCount: Number(d.attemptsCount) || 0,
    createdAt: d.createdAt || new Date().toISOString(),
  };
}

export async function fetchQuizzesFromFirestore(): Promise<InteractiveQuiz[]> {
  try {
    const snap = await getDocs(collection(db, 'quizzes'));
    const list: InteractiveQuiz[] = [];
    snap.forEach((docSnap) => {
      list.push(parseRemoteQuiz(docSnap.data()));
    });
    return list;
  } catch (error) {
    console.warn('Firestore quizzes fetch fallback:', error);
    return [];
  }
}

export function subscribeToFirestoreQuizzes(
  onData: (quizzes: InteractiveQuiz[], removedIds?: string[]) => void
): () => void {
  const path = 'quizzes';
  return onSnapshot(
    collection(db, path),
    (snapshot) => {
      const list: InteractiveQuiz[] = [];
      snapshot.forEach((docSnap) => {
        list.push(parseRemoteQuiz(docSnap.data()));
      });
      const removedIds = snapshot
        .docChanges()
        .filter((change) => change.type === 'removed')
        .map((change) => change.doc.id);
      onData(list, removedIds);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

// Weekly Study Progress Cloud Persistence
export async function saveStudyProgressToFirestore(data: {
  weeklyGoalHours: number;
  dailyProgress: any[];
  subjectProgress: Record<string, number>;
  subjectSessions: Record<string, number>;
  lastUpdated: string;
}): Promise<void> {
  if (!auth.currentUser) return;
  const uid = auth.currentUser.uid;
  const path = `users/${uid}/progress/weekly`;
  try {
    await setDoc(
      doc(db, 'users', uid, 'progress', 'weekly'),
      {
        userId: uid,
        weeklyGoalHours: Number(data.weeklyGoalHours) || 21,
        dailyProgressJson: JSON.stringify(data.dailyProgress || []).slice(0, 9900),
        subjectProgressJson: JSON.stringify(data.subjectProgress || {}).slice(0, 9900),
        subjectSessionsJson: JSON.stringify(data.subjectSessions || {}).slice(0, 9900),
        lastUpdated: data.lastUpdated || new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function fetchStudyProgressFromFirestore(userId: string): Promise<{
  weeklyGoalHours: number;
  dailyProgress: any[];
  subjectProgress: Record<string, number>;
  subjectSessions: Record<string, number>;
  lastUpdated: string;
} | null> {
  const path = `users/${userId}/progress/weekly`;
  try {
    const snap = await getDoc(doc(db, 'users', userId, 'progress', 'weekly'));
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      weeklyGoalHours: Number(d.weeklyGoalHours) || 21,
      dailyProgress: JSON.parse(d.dailyProgressJson || '[]'),
      subjectProgress: JSON.parse(d.subjectProgressJson || '{}'),
      subjectSessions: JSON.parse(d.subjectSessionsJson || '{}'),
      lastUpdated: d.lastUpdated || new Date().toISOString(),
    };
  } catch (error) {
    console.warn('Study progress Firestore fetch note:', error);
    return null;
  }
}

// Reminder Cloud Persistence
export async function saveReminderToFirestore(reminder: StudyReminder): Promise<void> {
  if (!auth.currentUser) return;
  const remPath = `reminders/${reminder.id}`;
  try {
    const remRef = doc(db, 'reminders', reminder.id);
    const cloudReminder = {
      id: reminder.id,
      userId: auth.currentUser.uid,
      subjectId: String(reminder.subjectId || 'arabic').slice(0, 50),
      customSubjectName: String(reminder.customSubjectName || '').slice(0, 100),
      title: String(reminder.title || 'موعد مراجعة').trim().slice(0, 200) || 'موعد مراجعة',
      targetDate: String(reminder.targetDate || '').slice(0, 20),
      targetTime: String(reminder.targetTime || '17:00').slice(0, 10),
      repeatType: ['once', 'daily', 'weekdays', 'custom'].includes(reminder.repeatType)
        ? reminder.repeatType
        : 'once',
      priority: ['normal', 'medium', 'high'].includes(reminder.priority)
        ? reminder.priority
        : 'medium',
      isActive: Boolean(reminder.isActive),
      isCompleted: Boolean(reminder.isCompleted),
      notes: String(reminder.notes || '').slice(0, 1000),
      linkedDocId: String(reminder.linkedDocId || '').slice(0, 128),
      linkedDocTitle: String(reminder.linkedDocTitle || '').slice(0, 200),
      createdAt: reminder.createdAt || new Date().toISOString(),
    };
    await setDoc(remRef, cloudReminder, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, remPath);
  }
}

export async function deleteReminderFromFirestore(reminderId: string): Promise<void> {
  deleteReminderFromPublicServer(reminderId).catch(() => {});
  if (!auth.currentUser) return;
  const remPath = `reminders/${reminderId}`;
  try {
    await deleteDoc(doc(db, 'reminders', reminderId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, remPath);
  }
}

export function subscribeToUserReminders(
  userId: string,
  onData: (reminders: StudyReminder[], removedIds?: string[]) => void
): () => void {
  const path = 'reminders';
  const q = query(collection(db, path), where('userId', '==', userId));
  return onSnapshot(
    q,
    (snapshot) => {
      const reminders: StudyReminder[] = [];
      snapshot.forEach((snap) => {
        reminders.push(snap.data() as StudyReminder);
      });
      const removedIds = snapshot
        .docChanges()
        .filter((change) => change.type === 'removed')
        .map((change) => change.doc.id);
      onData(reminders, removedIds);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

// Quick Notes Persistence in Firebase (مرتبطة بكل مستخدم وكل مذكرة)
export async function saveQuickNoteToFirestore(note: DocumentQuickNote): Promise<void> {
  if (!auth.currentUser) {
    // Save to local storage for guests / offline
    const localKey = `qalami_notes_${note.docId}`;
    try {
      const local = JSON.parse(localStorage.getItem(localKey) || '[]');
      const index = local.findIndex((n: DocumentQuickNote) => n.id === note.id);
      if (index >= 0) {
        local[index] = note;
      } else {
        local.unshift(note);
      }
      localStorage.setItem(localKey, JSON.stringify(local));
    } catch (e) {
      console.warn('Local storage notes write error:', e);
    }
    return;
  }

  const notePath = `users/${auth.currentUser.uid}/notes/${note.id}`;
  try {
    const noteRef = doc(db, 'users', auth.currentUser.uid, 'notes', note.id);
    const dataToSave = {
      id: String(note.id).slice(0, 128),
      userId: auth.currentUser.uid,
      docId: String(note.docId).slice(0, 128),
      content: String(note.content || '').trim().slice(0, 5000) || 'ملاحظة',
      pageNumber: Number(note.pageNumber ?? 1),
      color: String(note.color || 'amber').slice(0, 30),
      createdAt: String(note.createdAt || new Date().toISOString()).slice(0, 50),
      updatedAt: new Date().toISOString(),
    };
    await setDoc(noteRef, dataToSave, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, notePath);
  }
}

export async function deleteQuickNoteFromFirestore(docId: string, noteId: string): Promise<void> {
  if (!auth.currentUser) {
    const localKey = `qalami_notes_${docId}`;
    try {
      const local = JSON.parse(localStorage.getItem(localKey) || '[]');
      const filtered = local.filter((n: DocumentQuickNote) => n.id !== noteId);
      localStorage.setItem(localKey, JSON.stringify(filtered));
    } catch (e) {
      console.warn('Local storage notes delete error:', e);
    }
    return;
  }

  const notePath = `users/${auth.currentUser.uid}/notes/${noteId}`;
  try {
    const noteRef = doc(db, 'users', auth.currentUser.uid, 'notes', noteId);
    await deleteDoc(noteRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, notePath);
  }
}

export function subscribeToDocumentQuickNotes(
  docId: string,
  onData: (notes: DocumentQuickNote[]) => void
): () => void {
  const currentUid = auth.currentUser?.uid;
  if (!currentUid) {
    const localKey = `qalami_notes_${docId}`;
    try {
      const local = JSON.parse(localStorage.getItem(localKey) || '[]');
      onData(local);
    } catch {
      onData([]);
    }
    const handleStorage = (e: StorageEvent) => {
      if (e.key === localKey) {
        try {
          onData(JSON.parse(e.newValue || '[]'));
        } catch {
          onData([]);
        }
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }

  const path = `users/${currentUid}/notes`;
  const q = query(
    collection(db, 'users', currentUid, 'notes'),
    where('docId', '==', docId)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const notes: DocumentQuickNote[] = [];
      snapshot.forEach((snap) => {
        notes.push(snap.data() as DocumentQuickNote);
      });
      notes.sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
      onData(notes);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

