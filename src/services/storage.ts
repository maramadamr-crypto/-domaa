import { StudyDocument, UserProfile, DocumentPage, DocumentComment, PeoplePageInfo, SubjectId } from '../types';
import { jsPDF } from 'jspdf';
import { generateId, ensurePdfPageRendered } from './fileProcessor';
import {
  getAllDocumentsFromDb,
  saveDocumentToDb,
  deleteDocumentFromDb,
  deletePdfFileFromDb,
  migrateFromLocalStorage,
  isIndexedDBAvailable,
} from './indexedDbService';
import {
  auth,
  isRealImageUrl,
  saveDocumentToFirestore,
  deleteDocumentFromFirestore,
  fetchDocumentPagesBatchFromCloud,
} from './firebase';

const STORAGE_KEYS = {
  DOCUMENTS: 'qalami_documents_v1',
  DELETED_DOCS: 'qalami_deleted_docs_v1',
  PROFILES: 'qalami_profiles_v1',
  ACTIVE_PROFILE: 'qalami_active_profile_v1',
  THEME: 'qalami_theme_mode',
  SUBSCRIPTIONS: 'qalami_subscriptions_v1',
  SUBSCRIBER_COUNTS: 'qalami_subscriber_counts_v1',
};

// Real User Profiles (Strictly 0 fake profiles per user instruction: "الغي كل صفحات الناس المزيفه")
export const DEFAULT_PROFILES: UserProfile[] = [];

const FALLBACK_GUEST_PROFILE: UserProfile = {
  id: 'guest_user',
  name: 'طالب',
  role: 'student',
  grade: 'الصف الخامس الابتدائي',
  avatarColor: 'from-amber-500 to-orange-600',
};

// In-Memory Document Cache for instant synchronous access
let cachedDocuments: StudyDocument[] = [];
let isDbLoaded = false;
const listeners: Array<(docs: StudyDocument[]) => void> = [];
const fullHydrationDone = new Set<string>();
const inFlightFullHydration = new Map<string, Promise<void>>();
const inFlightPriorityFetch = new Map<string, Promise<void>>();

function isMissingOrPlaceholderImage(url?: string): boolean {
  return !isRealImageUrl(url);
}

function notifyListeners() {
  const current = [...cachedDocuments];
  listeners.forEach((fn) => {
    try {
      fn(current);
    } catch (e) {
      console.warn('Listener error', e);
    }
  });
}

function getDeletedDocIdSet(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.DELETED_DOCS);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id) : []);
  } catch {
    return new Set();
  }
}

function addDeletedDocIds(ids: string[]): Set<string> {
  const set = getDeletedDocIdSet();
  let added = false;
  for (const id of ids) {
    if (typeof id === 'string' && id && !set.has(id)) {
      set.add(id);
      added = true;
    }
  }
  if (added && typeof window !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEYS.DELETED_DOCS, JSON.stringify(Array.from(set).slice(-5000)));
    } catch {
      // ignore
    }
  }
  return set;
}

function persistLightweightMetadata(): void {
  if (typeof window === 'undefined') return;
  try {
    const lightweightMeta = cachedDocuments.map((d) => ({
      id: d.id,
      title: d.title,
      subject: d.subject,
      customSubjectName: d.customSubjectName,
      docType: d.docType,
      format: d.format,
      grade: d.grade,
      term: d.term,
      author: d.author,
      description: d.description,
      tags: d.tags,
      pageCount: d.pages?.length || 0,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      userId: d.userId,
      isFavorite: d.isFavorite,
    }));
    localStorage.setItem('qalami_docs_metadata_v1', JSON.stringify(lightweightMeta));
  } catch {
    // ignore
  }
}

// Initial bootstrap: try loading from localStorage first, then immediately migrate to IndexedDB
if (typeof window !== 'undefined') {
  const deletedSet = getDeletedDocIdSet();
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.DOCUMENTS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        cachedDocuments = parsed.filter((d) => d?.id && !deletedSet.has(d.id));
      }
    }
  } catch (e) {
    console.warn('Initial localStorage read note', e);
  }

  // Asynchronously migrate and load from IndexedDB
  (async () => {
    try {
      if (isIndexedDBAvailable()) {
        // Migrate legacy localStorage documents if present
        await migrateFromLocalStorage(STORAGE_KEYS.DOCUMENTS);
        // Load authoritative data from IndexedDB, filtering out any tombstoned documents
        const dbDocs = await getAllDocumentsFromDb();
        const latestDeleted = getDeletedDocIdSet();
        const activeDbDocs = dbDocs.filter((d) => d?.id && !latestDeleted.has(d.id));
        if (activeDbDocs.length > 0 || !cachedDocuments.length) {
          cachedDocuments = activeDbDocs;
        }
        isDbLoaded = true;
        notifyListeners();
      }
    } catch (err) {
      console.warn('IndexedDB initialization note:', err);
    }
  })();
}

/**
 * Storage API using IndexedDB for unlimited document storage (avoiding 5MB localStorage limits)
 * with instant in-memory cache and localStorage fallback for lightweight metadata
 */
export const StorageService = {
  // Subscribe to storage changes
  subscribe(listener: (docs: StudyDocument[]) => void): () => void {
    listeners.push(listener);
    // Call immediately with current state
    listener([...cachedDocuments]);
    return () => {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  },

  async init(): Promise<StudyDocument[]> {
    if (isDbLoaded) return [...cachedDocuments];
    try {
      if (isIndexedDBAvailable()) {
        await migrateFromLocalStorage(STORAGE_KEYS.DOCUMENTS);
        const docs = await getAllDocumentsFromDb();
        const deletedSet = getDeletedDocIdSet();
        const filteredDocs = docs.filter((d) => d?.id && !deletedSet.has(d.id));
        if (filteredDocs.length > 0 || !cachedDocuments.length) {
          cachedDocuments = filteredDocs;
        }
        isDbLoaded = true;
        notifyListeners();
      }
    } catch (e) {
      console.warn('StorageService.init note:', e);
    }
    return [...cachedDocuments];
  },

  // --- Profiles (Only real accounts, zero fake people) ---
  getProfiles(): UserProfile[] {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.PROFILES);
      if (data) {
        const parsed: UserProfile[] = JSON.parse(data);
        if (Array.isArray(parsed)) {
          // Strictly purge any legacy fake seeded profiles
          return parsed.filter(
            (p) =>
              p.id !== 'user_student_1' &&
              p.id !== 'user_teacher_1' &&
              !p.name?.includes('أحمد محمود') &&
              !p.name?.includes('محمد إبراهيم')
          );
        }
      }
    } catch (e) {
      console.error('Failed to get profiles', e);
    }
    return [];
  },

  saveProfiles(profiles: UserProfile[]) {
    try {
      localStorage.setItem(STORAGE_KEYS.PROFILES, JSON.stringify(profiles));
    } catch (e) {
      console.error('Failed to save profiles', e);
    }
  },

  getActiveProfileId(): string {
    return localStorage.getItem(STORAGE_KEYS.ACTIVE_PROFILE) || 'guest_user';
  },

  getActiveProfile(): UserProfile {
    const id = this.getActiveProfileId();
    const profiles = this.getProfiles();
    return profiles.find((p) => p.id === id) || profiles[0] || FALLBACK_GUEST_PROFILE;
  },

  updateActiveProfile(updates: Partial<UserProfile>): UserProfile {
    const activeId = this.getActiveProfileId();
    const profiles = this.getProfiles();
    const index = profiles.findIndex((p) => p.id === activeId);
    let updated: UserProfile;
    if (index >= 0) {
      updated = { ...profiles[index], ...updates, updatedAt: new Date().toISOString() };
      profiles[index] = updated;
    } else {
      updated = {
        id: activeId,
        name: updates.name || 'طالب متميز',
        role: updates.role || 'student',
        grade: updates.grade || 'الصف الخامس الابتدائي',
        avatarColor: updates.avatarColor || 'from-amber-500 to-orange-600',
        ...updates,
        updatedAt: new Date().toISOString(),
      };
      profiles.push(updated);
    }
    this.saveProfiles(profiles);
    notifyListeners();
    return updated;
  },

  // --- Subscriptions & Follow System (اشتراكات حقيقية في صفحات الناشرين والمعلمين) ---
  getSubscriptions(): string[] {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.SUBSCRIPTIONS);
      if (data) return JSON.parse(data);
    } catch {
      // ignore
    }
    return [];
  },

  isSubscribed(publisherKey: string): boolean {
    if (!publisherKey) return false;
    const subs = this.getSubscriptions();
    return subs.includes(publisherKey.trim());
  },

  toggleSubscription(publisherKey: string): boolean {
    if (!publisherKey) return false;
    const key = publisherKey.trim();
    let subs = this.getSubscriptions();
    let isNowSubscribed = false;

    if (subs.includes(key)) {
      subs = subs.filter((s) => s !== key);
      isNowSubscribed = false;
    } else {
      subs.push(key);
      isNowSubscribed = true;
    }

    try {
      localStorage.setItem(STORAGE_KEYS.SUBSCRIPTIONS, JSON.stringify(subs));
    } catch {
      // ignore
    }

    // Update subscriber counts dictionary
    const counts = this.getStoredSubscriberCounts();
    const currentCount = typeof counts[key] === 'number' ? counts[key] : (this.isSubscribed(key) ? 1 : 0);
    counts[key] = Math.max(0, currentCount + (isNowSubscribed ? 1 : -1));
    try {
      localStorage.setItem(STORAGE_KEYS.SUBSCRIBER_COUNTS, JSON.stringify(counts));
    } catch {
      // ignore
    }

    notifyListeners();
    return isNowSubscribed;
  },

  getStoredSubscriberCounts(): Record<string, number> {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.SUBSCRIBER_COUNTS);
      if (data) return JSON.parse(data);
    } catch {
      // ignore
    }
    return {};
  },

  getBaseSubscribersCount(_publisherKey: string): number {
    // 0 fake subscribers as requested by user ("ومتحطش مشتركين مزيفين في الصفحه")
    return 0;
  },

  getSubscribersCount(publisherKey: string): number {
    if (!publisherKey) return 0;
    const key = publisherKey.trim();
    const counts = this.getStoredSubscriberCounts();
    if (typeof counts[key] === 'number') {
      return counts[key];
    }
    // Only real subscriptions: if user is subscribed to this key, count is 1, otherwise 0
    return this.isSubscribed(key) ? 1 : 0;
  },

  // Get or construct a publisher profile for any user or author
  getPublisherProfile(authorOrUserId: string): UserProfile {
    const profiles = this.getProfiles();
    const active = this.getActiveProfile();

    // Check if it's the active user
    if (authorOrUserId === active.id || authorOrUserId === active.name) {
      return active;
    }

    // Check existing profiles
    const found = profiles.find((p) => p.id === authorOrUserId || p.name === authorOrUserId);
    if (found) return found;

    // Check documents for matching author
    const docWithAuthor = cachedDocuments.find(
      (d) => d.userId === authorOrUserId || d.author === authorOrUserId
    );

    const isTeacher = Boolean(authorOrUserId.includes('أستاذ') || authorOrUserId.includes('معلم') || docWithAuthor?.author.includes('أستاذ'));

    return {
      id: docWithAuthor?.userId || `publisher_${authorOrUserId}`,
      name: docWithAuthor?.author || authorOrUserId,
      role: isTeacher ? 'teacher' : 'student',
      grade: docWithAuthor?.grade || 'الصف الخامس الابتدائي',
      bio: isTeacher 
        ? 'معلم متميز متخصص في إعداد المذكرات والمراجعات ونماذج الامتحانات المعتمدة 📚'
        : 'طالب ناشر للمذكرات والملخصات والحلول النموذجية للدروس 🌟',
      avatarColor: isTeacher ? 'from-blue-600 to-indigo-700' : 'from-emerald-500 to-teal-600',
    };
  },

  // Get all people's pages / publisher channels for search and directory
  getAllPeoplePages(): PeoplePageInfo[] {
    const active = this.getActiveProfile();
    const storedProfiles = this.getProfiles();
    const docs = cachedDocuments;

    const peopleMap = new Map<string, PeoplePageInfo>();

    // 1. Add currently active user who entered the site
    const activeSubsKey = active.id || active.name;
    const activeDocs = docs.filter(
      (d) =>
        d.userId === active.id ||
        d.author === active.name ||
        (active.name && d.author && d.author.trim() === active.name.trim())
    );
    const activeSubjects = Array.from(new Set(activeDocs.map((d) => d.subject))) as SubjectId[];

    peopleMap.set(active.name.toLowerCase().trim(), {
      id: active.id,
      name: active.name,
      role: active.role || 'student',
      grade: active.grade || 'الصف الخامس الابتدائي',
      bio: active.bio || 'طالب متميز محب للعلم والمعرفة ومراجعة الدروس أولاً بأول 🌟',
      avatarColor: active.avatarColor || 'from-amber-500 to-orange-600',
      photoURL: active.photoURL,
      documentsCount: activeDocs.length,
      subscribersCount: this.getSubscribersCount(activeSubsKey), // 0 for newly created page!
      subjects: activeSubjects,
      isMyPage: true,
      isSubscribed: false,
    });

    // 3. Extract all unique authors/creators from documents
    for (const doc of docs) {
      if (!doc.author) continue;
      const authorTrimmed = doc.author.trim();
      const authorKey = authorTrimmed.toLowerCase();

      if (peopleMap.has(authorKey)) continue;

      const isTeacher = Boolean(
        authorTrimmed.includes('أستاذ') ||
        authorTrimmed.includes('معلم') ||
        authorTrimmed.includes('مستر') ||
        authorTrimmed.includes('دكتور')
      );
      const isPublisherHouse = Boolean(
        authorTrimmed.includes('كتاب') ||
        authorTrimmed.includes('الأضواء') ||
        authorTrimmed.includes('سلاح التلميذ') ||
        authorTrimmed.includes('الامتحان') ||
        authorTrimmed.includes('المعاصر') ||
        authorTrimmed.includes('دار')
      );

      const targetKey = doc.userId || authorTrimmed;
      const authorDocs = docs.filter((d) => d.author === authorTrimmed || d.userId === doc.userId);
      const authorSubjects = Array.from(new Set(authorDocs.map((d) => d.subject))) as SubjectId[];

      peopleMap.set(authorKey, {
        id: targetKey,
        name: authorTrimmed,
        role: isTeacher ? 'teacher' : 'student',
        grade: doc.grade || 'الصف الخامس الابتدائي',
        bio: isPublisherHouse
          ? 'دار نشر تعليمية متخصصة في الكتب والمذكرات ونماذج الامتحانات المعتمدة 📖'
          : isTeacher
          ? `معلم متخصص في تدريس ومراجعات ${doc.customSubjectName || doc.subject} 👨‍🏫`
          : 'طالب وناشر متميز لمذكرات وحلول المواد الدراسية 🎓',
        avatarColor: isPublisherHouse
          ? 'from-purple-600 to-pink-600'
          : isTeacher
          ? 'from-blue-600 to-indigo-700'
          : 'from-emerald-500 to-teal-600',
        photoURL: undefined,
        documentsCount: authorDocs.length,
        subscribersCount: this.getSubscribersCount(targetKey), // 0 for new pages!
        subjects: authorSubjects,
        isMyPage: targetKey === active.id || authorTrimmed === active.name,
        isSubscribed: this.isSubscribed(targetKey),
      });
    }

    // 4. Also extract authors from published videos (Shorts & Lessons)
    try {
      const rawVideos = typeof window !== 'undefined' ? localStorage.getItem('qalami_videos_store_v1') : null;
      if (rawVideos) {
        const videos = JSON.parse(rawVideos);
        if (Array.isArray(videos)) {
          for (const v of videos) {
            if (!v.author) continue;
            const authorTrimmed = v.author.trim();
            const authorKey = authorTrimmed.toLowerCase();
            if (peopleMap.has(authorKey)) continue;

            const isTeacher = Boolean(
              authorTrimmed.includes('أستاذ') ||
              authorTrimmed.includes('معلم') ||
              authorTrimmed.includes('مستر') ||
              authorTrimmed.includes('دكتور')
            );
            const targetKey = v.userId || authorTrimmed;
            peopleMap.set(authorKey, {
              id: targetKey,
              name: authorTrimmed,
              role: isTeacher ? 'teacher' : 'student',
              grade: 'الصف الخامس الابتدائي',
              bio: isTeacher
                ? `معلم ناشر لشروحات وفيديوهات تعليمية 👨‍🏫`
                : 'طالب ناشر لفيديوهات وشروحات دراسية 🎓',
              avatarColor: isTeacher ? 'from-blue-600 to-indigo-700' : 'from-rose-500 to-amber-600',
              photoURL: undefined,
              documentsCount: 0,
              subscribersCount: this.getSubscribersCount(targetKey), // 0 subscribers for new pages!
              subjects: [],
              isMyPage: targetKey === active.id || authorTrimmed === active.name,
              isSubscribed: this.isSubscribed(targetKey),
            });
          }
        }
      }
    } catch {
      // safe fallback
    }

    return Array.from(peopleMap.values());
  },


  // --- Documents (stored in IndexedDB + in-memory cache, quota-free) ---
  getDocuments(userId?: string): StudyDocument[] {
    if (userId) {
      return cachedDocuments.filter((d) => d.userId === userId);
    }
    return [...cachedDocuments];
  },

  getDocumentById(id: string): StudyDocument | null {
    return cachedDocuments.find((d) => d.id === id) || null;
  },

  saveDocument(doc: StudyDocument, options?: { syncPages?: boolean }): void {
    try {
      if (getDeletedDocIdSet().has(doc.id)) return;
      doc.updatedAt = new Date().toISOString();
      const index = cachedDocuments.findIndex((d) => d.id === doc.id);
      if (index >= 0) {
        cachedDocuments[index] = { ...doc };
      } else {
        cachedDocuments.unshift({ ...doc });
      }

      // 1. Asynchronously persist to IndexedDB (virtually unlimited quota)
      saveDocumentToDb(doc).catch((err) => {
        console.warn('IndexedDB background write note:', err);
      });

      // 1.1 Sync document to Firebase Firestore & Public Relay in background
      saveDocumentToFirestore(doc, { syncPages: options?.syncPages ?? true }).catch(() => {
        // Safe fallback when unauthenticated or offline
      });

      // 2. Notify in-app subscribers immediately
      notifyListeners();

      // 3. Store lightweight metadata only in localStorage
      persistLightweightMetadata();
    } catch (e) {
      console.error('saveDocument note:', e);
    }
  },

  deleteDocument(id: string): void {
    addDeletedDocIds([id]);
    const existing = cachedDocuments.find((d) => d.id === id);
    cachedDocuments = cachedDocuments.filter((d) => d.id !== id);
    fullHydrationDone.delete(id);
    deleteDocumentFromDb(id).catch((err) => {
      console.warn('IndexedDB delete note:', err);
    });
    if (existing?.pdfFileId) {
      deletePdfFileFromDb(existing.pdfFileId).catch(() => {});
    }
    deleteDocumentFromFirestore(id).catch(() => {
      // Safe fallback when unauthenticated or offline
    });
    persistLightweightMetadata();
    notifyListeners();
  },

  reconcileDeletedDocuments(deletedIds: string[]): void {
    if (!Array.isArray(deletedIds) || deletedIds.length === 0) return;
    const deletedSet = addDeletedDocIds(deletedIds);
    const toRemove = cachedDocuments.filter((d) => deletedSet.has(d.id));
    for (const id of deletedIds) {
      fullHydrationDone.delete(id);
      if (id) {
        deleteDocumentFromDb(id).catch(() => {});
      }
    }
    if (toRemove.length === 0) return;

    cachedDocuments = cachedDocuments.filter((d) => !deletedSet.has(d.id));
    for (const removed of toRemove) {
      if (removed.pdfFileId) {
        deletePdfFileFromDb(removed.pdfFileId).catch(() => {});
      }
    }
    persistLightweightMetadata();
    notifyListeners();
  },

  mergeCloudDocuments(cloudDocs: Partial<StudyDocument>[]): void {
    if (!Array.isArray(cloudDocs) || cloudDocs.length === 0) return;
    const deletedSet = getDeletedDocIdSet();
    let changed = false;
    const docsNeedingHydration = new Set<string>();

    for (const remote of cloudDocs) {
      if (!remote?.id || deletedSet.has(remote.id)) continue;
      const idx = cachedDocuments.findIndex((d) => d.id === remote.id);

      if (idx >= 0) {
        const local = cachedDocuments[idx];
        const remoteTime = new Date(remote.updatedAt || 0).getTime();
        const localTime = new Date(local.updatedAt || 0).getTime();
        let pageImageUpdated = false;

        const mergedPages = (local.pages || []).map((lp) => {
          const rp = remote.pages?.find((p) => p.pageNumber === lp.pageNumber);
          let nextImg = lp.imageUrl;
          if (rp && !isMissingOrPlaceholderImage(rp.imageUrl) && isMissingOrPlaceholderImage(lp.imageUrl)) {
            nextImg = rp.imageUrl;
            pageImageUpdated = true;
          }
          const nextAnnotations =
            rp &&
            Array.isArray(rp.annotations) &&
            rp.annotations.length > 0 &&
            (lp.annotations.length === 0 || remoteTime > localTime)
              ? rp.annotations
              : lp.annotations;
          if (nextImg !== lp.imageUrl || nextAnnotations !== lp.annotations) {
            return { ...lp, imageUrl: nextImg, annotations: nextAnnotations };
          }
          return lp;
        });

        // If remote metadata reports more pages than local reconstructs, append the new page slots
        if (remote.pages && remote.pages.length > mergedPages.length) {
          const existingNums = new Set(mergedPages.map((p) => p.pageNumber));
          for (const rp of remote.pages) {
            if (!existingNums.has(rp.pageNumber)) {
              mergedPages.push({
                id: rp.id || `${remote.id}_p${rp.pageNumber}`,
                pageNumber: rp.pageNumber,
                imageUrl: !isMissingOrPlaceholderImage(rp.imageUrl) ? rp.imageUrl : '',
                annotations: Array.isArray(rp.annotations) ? rp.annotations : [],
                lastEdited: rp.lastEdited || Date.now(),
              });
              pageImageUpdated = true;
            }
          }
          mergedPages.sort((a, b) => a.pageNumber - b.pageNumber);
        }

        const hasRemoteRatings =
          typeof remote.ratingsCount === 'number' && remote.ratingsCount > (local.ratingsCount || 0);
        const hasRemoteComments =
          Array.isArray(remote.comments) && remote.comments.length > (local.comments?.length || 0);
        const remoteNewer = remoteTime > localTime;

        if (remoteNewer || hasRemoteRatings || hasRemoteComments || pageImageUpdated) {
          const updated: StudyDocument = {
            ...local,
            title: remoteNewer && remote.title ? remote.title : local.title,
            description: remoteNewer && remote.description !== undefined ? remote.description : local.description,
            averageRating: hasRemoteRatings || remoteNewer ? (remote.averageRating ?? local.averageRating) : local.averageRating,
            ratingsCount: hasRemoteRatings ? remote.ratingsCount : local.ratingsCount,
            comments: hasRemoteComments ? remote.comments : local.comments,
            bookmarks:
              remoteNewer && Array.isArray(remote.bookmarks) ? remote.bookmarks : local.bookmarks,
            tags: remoteNewer && Array.isArray(remote.tags) ? remote.tags : local.tags,
            pages: mergedPages,
            updatedAt: remoteNewer && remote.updatedAt ? remote.updatedAt : local.updatedAt,
          };
          cachedDocuments[idx] = updated;
          saveDocumentToDb(updated).catch(() => {});
          changed = true;
        }

        if (!local.pdfFileId && (cachedDocuments[idx].pages || []).some((p) => isMissingOrPlaceholderImage(p.imageUrl))) {
          fullHydrationDone.delete(remote.id);
          docsNeedingHydration.add(remote.id);
        }
      } else {
        const reconstructedPages = (remote.pages && remote.pages.length > 0
          ? remote.pages
          : [{ id: `${remote.id}_p1`, pageNumber: 1, imageUrl: '', annotations: [], lastEdited: Date.now() }]
        ).map((p) => ({
          id: p.id || `${remote.id}_p${p.pageNumber}`,
          pageNumber: p.pageNumber || 1,
          imageUrl: !isMissingOrPlaceholderImage(p.imageUrl) ? p.imageUrl : '',
          annotations: Array.isArray(p.annotations) ? p.annotations : [],
          lastEdited: p.lastEdited || Date.now(),
        }));

        const newDoc: StudyDocument = {
          id: remote.id,
          title: remote.title || 'مذكرة دراسية',
          subject: (remote.subject as SubjectId) || 'arabic',
          customSubjectName: remote.customSubjectName || '',
          docType: remote.docType || 'booklet',
          format: remote.format || 'files',
          grade: remote.grade || 'الصف الخامس الابتدائي',
          term: remote.term || 'term1',
          author: remote.author || 'طالب',
          description: remote.description || '',
          tags: Array.isArray(remote.tags) ? remote.tags : [],
          pages: reconstructedPages,
          createdAt: remote.createdAt || new Date().toISOString(),
          updatedAt: remote.updatedAt || new Date().toISOString(),
          userId: remote.userId || '',
          averageRating: remote.averageRating ?? 5,
          ratingsCount: remote.ratingsCount ?? 0,
          comments: Array.isArray(remote.comments) ? remote.comments : [],
          bookmarks: Array.isArray(remote.bookmarks) ? remote.bookmarks : [],
        };
        cachedDocuments.push(newDoc);
        saveDocumentToDb(newDoc).catch(() => {});
        changed = true;

        if (reconstructedPages.some((p) => isMissingOrPlaceholderImage(p.imageUrl))) {
          fullHydrationDone.delete(remote.id);
          docsNeedingHydration.add(remote.id);
        }
      }
    }

    if (changed) {
      cachedDocuments.sort(
        (a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
      );
      notifyListeners();
    }

    // Silently pre-hydrate all missing pages in the background before the user even opens the memo
    for (const idToHydrate of docsNeedingHydration) {
      this.ensureDocumentPagesLoaded(idToHydrate, 1).catch(() => {});
    }
  },

  async hydrateSpecificPages(docId: string, pageNumbers: number[]): Promise<void> {
    if (!docId || !Array.isArray(pageNumbers) || pageNumbers.length === 0) return;
    const existingDoc = cachedDocuments.find((d) => d.id === docId);
    if (!existingDoc || existingDoc.pdfFileId) return;

    const targetNums = Array.from(
      new Set(
        pageNumbers
          .map((n) => Math.round(Number(n)))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= (existingDoc.pages?.length || 5000))
      )
    ).filter((n) => {
      const lp = existingDoc.pages?.find((p) => p.pageNumber === n);
      return !lp || isMissingOrPlaceholderImage(lp.imageUrl);
    });

    if (targetNums.length === 0) return;

    for (let i = 0; i < targetNums.length; i += 25) {
      const batch = targetNums.slice(i, i + 25);
      const fetchedBatch = await fetchDocumentPagesBatchFromCloud(docId, batch);
      if (fetchedBatch.length === 0) continue;

      const docIdx = cachedDocuments.findIndex((d) => d.id === docId);
      if (docIdx < 0) return;

      const current = cachedDocuments[docIdx];
      const remoteMap = new Map(fetchedBatch.map((rp) => [rp.pageNumber, rp]));
      let patched = false;

      const updatedPages = (current.pages || []).map((p) => {
        const rp = remoteMap.get(p.pageNumber);
        if (rp && !isMissingOrPlaceholderImage(rp.imageUrl) && isMissingOrPlaceholderImage(p.imageUrl)) {
          patched = true;
          return {
            ...p,
            imageUrl: rp.imageUrl,
            annotations:
              p.annotations && p.annotations.length > 0 ? p.annotations : rp.annotations || [],
          };
        }
        return p;
      });

      if (patched) {
        const updatedDoc = { ...current, pages: updatedPages };
        cachedDocuments[docIdx] = updatedDoc;
        saveDocumentToDb(updatedDoc).catch(() => {});
        notifyListeners();
        if (!updatedPages.some((p) => isMissingOrPlaceholderImage(p.imageUrl))) {
          fullHydrationDone.add(docId);
        }
      }
    }
  },

  removeRemoteDeletedDocument(docId: string): void {
    if (!docId) return;
    this.reconcileDeletedDocuments([docId]);
  },

  async ensureDocumentPagesLoaded(docId: string, priorityPageNumber: number = 1): Promise<void> {
    const existingDoc = cachedDocuments.find((d) => d.id === docId);
    if (!existingDoc || existingDoc.pdfFileId) return;

    const pages = existingDoc.pages || [];
    const needsAnyHydration = pages.some((p) => isMissingOrPlaceholderImage(p.imageUrl));
    if (!needsAnyHydration) {
      fullHydrationDone.add(docId);
      return;
    }

    // 1. Single-roundtrip priority fetch for active page & immediate neighbors
    const targetNums = Array.from(
      new Set([
        priorityPageNumber,
        priorityPageNumber + 1,
        priorityPageNumber + 2,
        priorityPageNumber + 3,
        priorityPageNumber - 1,
      ])
    ).filter(
      (num) =>
        num >= 1 &&
        num <= pages.length &&
        isMissingOrPlaceholderImage(pages.find((p) => p.pageNumber === num)?.imageUrl)
    );

    if (targetNums.length > 0) {
      const priorityKey = `${docId}_${targetNums.join(',')}`;
      const existingPriority = inFlightPriorityFetch.get(priorityKey);
      if (existingPriority) {
        await existingPriority;
      } else {
        const pTask = (async () => {
          try {
            const fetchedBatch = await fetchDocumentPagesBatchFromCloud(docId, targetNums);
            if (fetchedBatch.length === 0) return;

            const docIdx = cachedDocuments.findIndex((d) => d.id === docId);
            if (docIdx < 0) return;

            const current = cachedDocuments[docIdx];
            const remoteMap = new Map(fetchedBatch.map((rp) => [rp.pageNumber, rp]));
            let patched = false;

            const updatedPages = (current.pages || []).map((p) => {
              const rp = remoteMap.get(p.pageNumber);
              if (rp && !isMissingOrPlaceholderImage(rp.imageUrl) && isMissingOrPlaceholderImage(p.imageUrl)) {
                patched = true;
                return {
                  ...p,
                  imageUrl: rp.imageUrl,
                  annotations:
                    p.annotations && p.annotations.length > 0
                      ? p.annotations
                      : rp.annotations || [],
                };
              }
              return p;
            });

            if (patched) {
              const updatedDoc = { ...current, pages: updatedPages };
              cachedDocuments[docIdx] = updatedDoc;
              saveDocumentToDb(updatedDoc).catch(() => {});
              notifyListeners();
            }
          } finally {
            inFlightPriorityFetch.delete(priorityKey);
          }
        })();
        inFlightPriorityFetch.set(priorityKey, pTask);
        await pTask;
      }
    }

    // 2. Fast silent chunked background hydration for all remaining pages
    if (fullHydrationDone.has(docId)) return;
    const inflightFull = inFlightFullHydration.get(docId);
    if (inflightFull) return inflightFull;

    const fullTask = (async () => {
      try {
        const snapshotDoc = cachedDocuments.find((d) => d.id === docId);
        if (!snapshotDoc) return;

        const missingNums = (snapshotDoc.pages || [])
          .filter((p) => isMissingOrPlaceholderImage(p.imageUrl))
          .map((p) => p.pageNumber)
          .sort(
            (a, b) =>
              Math.abs(a - priorityPageNumber) - Math.abs(b - priorityPageNumber)
          );

        const chunkSize = 12;
        for (let i = 0; i < missingNums.length; i += chunkSize) {
          const batchNums = missingNums.slice(i, i + chunkSize);
          const fetchedBatch = await fetchDocumentPagesBatchFromCloud(docId, batchNums);
          if (fetchedBatch.length > 0) {
            const docIdx = cachedDocuments.findIndex((d) => d.id === docId);
            if (docIdx < 0) break;

            const current = cachedDocuments[docIdx];
            const remoteMap = new Map(fetchedBatch.map((rp) => [rp.pageNumber, rp]));
            let patched = false;

            const updatedPages = (current.pages || []).map((p) => {
              const rp = remoteMap.get(p.pageNumber);
              if (rp && !isMissingOrPlaceholderImage(rp.imageUrl) && isMissingOrPlaceholderImage(p.imageUrl)) {
                patched = true;
                return {
                  ...p,
                  imageUrl: rp.imageUrl,
                  annotations:
                    p.annotations && p.annotations.length > 0
                      ? p.annotations
                      : rp.annotations || [],
                };
              }
              return p;
            });

            if (patched) {
              const updatedDoc = { ...current, pages: updatedPages };
              cachedDocuments[docIdx] = updatedDoc;
              saveDocumentToDb(updatedDoc).catch(() => {});
              notifyListeners();
            }
          }

          if (i + chunkSize < missingNums.length) {
            await new Promise((r) => setTimeout(r, 5));
          }
        }

        const latest = cachedDocuments.find((d) => d.id === docId);
        if (latest && !(latest.pages || []).some((p) => isMissingOrPlaceholderImage(p.imageUrl))) {
          fullHydrationDone.add(docId);
        }
      } finally {
        inFlightFullHydration.delete(docId);
      }
    })();

    inFlightFullHydration.set(docId, fullTask);
    return fullTask;
  },

  syncLocalDocsToPublicServer(): void {
    const deletedSet = getDeletedDocIdSet();
    for (const docItem of cachedDocuments) {
      if (deletedSet.has(docItem.id)) continue;
      // Only push documents that actually originate locally on this device (PDF stored locally or real local images)
      const hasCompleteLocalOrigin =
        Boolean(docItem.pdfFileId) ||
        (Array.isArray(docItem.pages) &&
          docItem.pages.length > 0 &&
          docItem.pages.every((p) => !isMissingOrPlaceholderImage(p.imageUrl)));

      if (hasCompleteLocalOrigin) {
        saveDocumentToFirestore(docItem, {
          syncPages: true,
          checkExistingPagesFirst: true,
        }).catch(() => {});
      }
    }
  },

  syncLocalDocsToFirestore(): void {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const deletedSet = getDeletedDocIdSet();
    let updatedLocal = false;

    for (const docItem of cachedDocuments) {
      if (deletedSet.has(docItem.id)) continue;
      const isGuestOwned =
        !docItem.userId ||
        docItem.userId === 'guest_user' ||
        docItem.userId === 'grade_5_student' ||
        docItem.userId === 'public_publisher';

      const hasLocalOrigin =
        Boolean(docItem.pdfFileId) ||
        (Array.isArray(docItem.pages) &&
          docItem.pages.some((p) => !isMissingOrPlaceholderImage(p.imageUrl)));

      if ((isGuestOwned || docItem.userId === uid) && hasLocalOrigin) {
        if (isGuestOwned) {
          docItem.userId = uid;
          saveDocumentToDb(docItem).catch(() => {});
          updatedLocal = true;
        }
        saveDocumentToFirestore(docItem, {
          syncPages: true,
          checkExistingPagesFirst: true,
        }).catch(() => {});
      }
    }

    if (updatedLocal) {
      notifyListeners();
    }
  },

  toggleFavorite(id: string): void {
    const doc = this.getDocumentById(id);
    if (doc) {
      doc.isFavorite = !doc.isFavorite;
      this.saveDocument(doc);
    }
  },

  // Add a comment and rating to any published document
  addComment(docId: string, commentData: Omit<DocumentComment, 'id' | 'createdAt'>): StudyDocument | null {
    const doc = this.getDocumentById(docId);
    if (!doc) return null;

    const newComment: DocumentComment = {
      ...commentData,
      id: generateId(),
      createdAt: new Date().toISOString(),
    };

    const currentComments = doc.comments || [];
    const updatedComments = [newComment, ...currentComments];

    // Recalculate average rating
    const ratingsOnly = updatedComments.filter((c) => c.rating > 0).map((c) => c.rating);
    const avg = ratingsOnly.length > 0 
      ? Number((ratingsOnly.reduce((a, b) => a + b, 0) / ratingsOnly.length).toFixed(1))
      : commentData.rating || 5;

    doc.comments = updatedComments;
    doc.averageRating = avg;
    doc.ratingsCount = ratingsOnly.length;

    this.saveDocument(doc);
    return doc;
  },

  rateDocument(docId: string, rating: number): StudyDocument | null {
    const doc = this.getDocumentById(docId);
    if (!doc) return null;

    const currentCount = doc.ratingsCount || 0;
    const currentAvg = doc.averageRating || 5;
    const newCount = currentCount + 1;
    const newAvg = Number(((currentAvg * currentCount + rating) / newCount).toFixed(1));

    doc.averageRating = newAvg;
    doc.ratingsCount = newCount;

    this.saveDocument(doc);
    return doc;
  },

  // Auto-save specific page annotations
  savePageAnnotations(docId: string, pageNumber: number, annotations: any[]): void {
    const doc = this.getDocumentById(docId);
    if (!doc) return;
    const pageIndex = doc.pages.findIndex((p) => p.pageNumber === pageNumber);
    if (pageIndex >= 0) {
      doc.pages[pageIndex].annotations = annotations;
      doc.pages[pageIndex].lastEdited = Date.now();
      this.saveDocument(doc);
    }
  },

  // --- Export Service ---
  async exportAnnotatedPdf(doc: StudyDocument): Promise<void> {
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'pt',
      format: 'a4',
    });

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();

    // 1. Add Academic Cover Page (غلاف أكاديمي رسمي منظم للمذكرة)
    const coverCanvas = createAcademicCoverCanvas(doc);
    const coverData = coverCanvas.toDataURL('image/jpeg', 0.95);
    pdf.addImage(coverData, 'JPEG', 0, 0, pageWidth, pageHeight);

    // 2. Add each page with Academic Header & Footer and student notes
    for (let i = 0; i < doc.pages.length; i++) {
      pdf.addPage();
      const page = doc.pages[i];

      // Composite background image + annotations + academic headers
      const compositeCanvas = await renderCompositePage(page, doc, i, doc.pages.length);
      const imgData = compositeCanvas.toDataURL('image/jpeg', 0.94);

      const canvasRatio = compositeCanvas.width / (compositeCanvas.height || 1);
      const pdfRatio = pageWidth / pageHeight;

      let drawW = pageWidth;
      let drawH = pageHeight;
      let offsetX = 0;
      let offsetY = 0;

      if (canvasRatio > pdfRatio) {
        drawW = pageWidth;
        drawH = pageWidth / canvasRatio;
        offsetY = (pageHeight - drawH) / 2;
      } else {
        drawH = pageHeight;
        drawW = pageHeight * canvasRatio;
        offsetX = (pageWidth - drawW) / 2;
      }

      pdf.addImage(imgData, 'JPEG', offsetX, offsetY, drawW, drawH);
    }

    const sanitizedTitle = (doc.title || 'مذكرة-أكاديمية').replace(/[/\\?%*:|"<>]/g, '-');
    pdf.save(`${sanitizedTitle}-طبعة-أكاديمية.pdf`);
  },

  async exportSinglePagePdf(page: DocumentPage, doc: StudyDocument): Promise<void> {
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'pt',
      format: 'a4',
    });

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();

    const compositeCanvas = await renderCompositePage(page, doc, (page.pageNumber || 1) - 1, doc.pages.length);
    const imgData = compositeCanvas.toDataURL('image/jpeg', 0.94);

    const canvasRatio = compositeCanvas.width / (compositeCanvas.height || 1);
    const pdfRatio = pageWidth / pageHeight;

    let drawW = pageWidth;
    let drawH = pageHeight;
    let offsetX = 0;
    let offsetY = 0;

    if (canvasRatio > pdfRatio) {
      drawW = pageWidth;
      drawH = pageWidth / canvasRatio;
      offsetY = (pageHeight - drawH) / 2;
    } else {
      drawH = pageHeight;
      drawW = pageHeight * canvasRatio;
      offsetX = (pageWidth - drawW) / 2;
    }

    pdf.addImage(imgData, 'JPEG', offsetX, offsetY, drawW, drawH);
    const sanitizedTitle = (doc.title || 'صفحة-مذكرة').replace(/[/\\?%*:|"<>]/g, '-');
    pdf.save(`${sanitizedTitle}-صفحة-${page.pageNumber}.pdf`);
  },

  async exportPageAsImage(page: DocumentPage, title: string): Promise<void> {
    const compositeCanvas = await renderCompositePage(page);
    const link = document.createElement('a');
    link.download = `${title}_صفحة_${page.pageNumber}.png`;
    link.href = compositeCanvas.toDataURL('image/png');
    link.click();
  },

  // Sample exam model for Fifth Grade Arabic from "كتاب الامتحان"
  createSampleArabicExam(userId: string): StudyDocument {
    const p1 = createExamPage1();
    const p2 = createExamPage2();

    const sampleDoc: StudyDocument = {
      id: generateId(),
      title: 'نماذج اختبارات شهر أكتوبر لغة عربية - كتاب الامتحان',
      subject: 'arabic',
      docType: 'revision',
      format: 'files',
      grade: 'الصف الخامس الابتدائي',
      term: 'term1',
      author: 'كتاب الامتحان - طبعة 2026',
      description: 'نماذج اختبارات شاملة لشهر أكتوبر مطابقة لأحدث مواصفات الورقة الامتحانية لغة عربية للصف الخامس الابتدائي.',
      tags: ['اختبارات أكتوبر', 'كتاب الامتحان', 'لغة عربية', 'الصف الخامس', 'نحو وتعبير'],
      pages: [p1, p2],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userId,
      isFavorite: true,
      bookmarks: [1],
    };

    return sampleDoc;
  },
};

/**
 * Creates an Academic Formal Cover Page Canvas for PDF export
 */
function createAcademicCoverCanvas(doc: StudyDocument): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 1240;
  canvas.height = 1754; // A4 ratio at high resolution
  const ctx = canvas.getContext('2d')!;

  // Clean White Page Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Outer Border & Inner Border (Academic Double Frame)
  ctx.strokeStyle = '#1e3a8a';
  ctx.lineWidth = 6;
  ctx.strokeRect(40, 40, canvas.width - 80, canvas.height - 80);

  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 2;
  ctx.strokeRect(52, 52, canvas.width - 104, canvas.height - 104);

  // Top Academic Emblem Banner
  ctx.fillStyle = '#1e3a8a';
  ctx.fillRect(70, 70, canvas.width - 140, 105);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 30px "Cairo", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('منصة قلمي التعليمية • الطبعة الأكاديمية المعتمدة', canvas.width / 2, 125);

  ctx.font = 'bold 18px "Cairo", sans-serif';
  ctx.fillText('نسخة رسمية منظمة للمذاكرة، الطباعة، ومراجعة الاختبارات والمذكرات', canvas.width / 2, 155);

  // Document Classification Badge
  const docTypeLabel = doc.docType === 'solution' ? 'حل نموذجي' : doc.docType === 'book' ? 'كتاب كامل' : 'مراجعة وتلخيص';
  ctx.fillStyle = '#f59e0b';
  ctx.beginPath();
  ctx.roundRect((canvas.width / 2) - 130, 240, 260, 48, 24);
  ctx.fill();

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 22px "Cairo", sans-serif';
  ctx.fillText(`★ تصنيف: ${docTypeLabel} ★`, canvas.width / 2, 272);

  // Main Document Title (wrapped nicely)
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 42px "Cairo", sans-serif';
  ctx.textAlign = 'center';
  const words = doc.title.split(' ');
  let line = '';
  let yPos = 370;
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = ctx.measureText(testLine);
    if (metrics.width > canvas.width - 240 && n > 0) {
      ctx.fillText(line, canvas.width / 2, yPos);
      line = words[n] + ' ';
      yPos += 55;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, canvas.width / 2, yPos);

  // Decorative divider
  yPos += 40;
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(180, yPos);
  ctx.lineTo(canvas.width - 180, yPos);
  ctx.stroke();

  // Academic Info Cards Box
  yPos += 45;
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(120, yPos, canvas.width - 240, 220);
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(120, yPos, canvas.width - 240, 220);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#334155';
  ctx.font = 'bold 24px "Cairo", sans-serif';
  ctx.fillText(`• المادة: ${doc.customSubjectName || doc.subject}`, canvas.width - 160, yPos + 55);
  ctx.fillText(`• المرحلة / الصف: ${doc.grade || 'المرحلة الابتدائية'}`, canvas.width - 160, yPos + 105);
  ctx.fillText(`• الفصل الدراسي: ${doc.term === 'term1' ? 'الفصل الدراسي الأول' : doc.term === 'term2' ? 'الفصل الدراسي الثاني' : 'العام الكامل'}`, canvas.width - 160, yPos + 155);
  ctx.fillText(`• إعداد المعلم / المؤلف: ${doc.author || 'نخبة من معلمي المادة'}`, canvas.width - 160, yPos + 205);

  // Student Fill-in Box
  yPos += 260;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(120, yPos, canvas.width - 240, 230);
  ctx.strokeStyle = '#1e3a8a';
  ctx.lineWidth = 2;
  ctx.strokeRect(120, yPos, canvas.width - 240, 230);

  ctx.fillStyle = '#1e3a8a';
  ctx.fillRect(120, yPos, canvas.width - 240, 42);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 22px "Cairo", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('بيانات الطالب الأكاديمية (خاص بالطباعة والمذاكرة)', canvas.width / 2, yPos + 30);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#1e293b';
  ctx.font = 'bold 20px "Cairo", sans-serif';
  ctx.fillText('اسم الطالب: ............................................................................................', canvas.width - 160, yPos + 90);
  ctx.fillText('المدرسة: ...................................................................................................', canvas.width - 160, yPos + 138);
  ctx.fillText('الفصل / المجموعة: ...................................................................................', canvas.width - 160, yPos + 185);

  // Bottom Notice
  ctx.textAlign = 'center';
  ctx.fillStyle = '#64748b';
  ctx.font = '17px "Cairo", sans-serif';
  ctx.fillText(`عدد صفحات المذكرة: ${doc.pages.length} صفحة  •  تحتوي على شروحات وتدوينات الطالب`, canvas.width / 2, canvas.height - 110);
  ctx.fillText('طُبعت ونُظمت رقمياً بواسطة قلمي - القارئ والمساعد التعليمي الذكي', canvas.width / 2, canvas.height - 80);

  return canvas;
}

/**
 * Composite Page Renderer: Combines the base document image, annotations, and academic headers/footers
 */
async function renderCompositePage(
  page: DocumentPage,
  doc?: StudyDocument,
  pageIndex?: number,
  totalPages?: number
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  canvas.width = 1200;
  canvas.height = 1600;

  // Background default white
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let resolvedImageUrl = page.imageUrl;
  if (!resolvedImageUrl && doc?.pdfFileId) {
    resolvedImageUrl = await ensurePdfPageRendered(doc.pdfFileId, page.pageNumber, 1.2);
  }

  if (resolvedImageUrl) {
    try {
      const img = new Image();
      if (!resolvedImageUrl.startsWith('data:')) {
        img.crossOrigin = 'anonymous';
      }
      await new Promise<void>((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => resolve();
        img.src = resolvedImageUrl;
      });

      if (img.width > 0 && img.height > 0) {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }
    } catch (e) {
      console.warn('Composite page image rendering skipped', e);
    }
  }

  // Render annotations on top
  const scale = canvas.width / 1000; // normalized coordinate space

  for (const ann of page.annotations || []) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = (ann.strokeWidth || 3) * scale;
    ctx.strokeStyle = ann.color || '#000000';
    ctx.fillStyle = ann.color || '#000000';

    if (ann.type === 'highlighter') {
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = (ann.strokeWidth || 18) * scale;
    } else {
      ctx.globalAlpha = ann.opacity || 1.0;
    }

    if ((ann.type === 'pen' || ann.type === 'highlighter') && ann.points && ann.points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(ann.points[0].x * scale, ann.points[0].y * scale);
      for (let j = 1; j < ann.points.length; j++) {
        ctx.lineTo(ann.points[j].x * scale, ann.points[j].y * scale);
      }
      ctx.stroke();
    } else if (ann.type === 'line' && ann.startPoint && ann.endPoint) {
      ctx.beginPath();
      ctx.moveTo(ann.startPoint.x * scale, ann.startPoint.y * scale);
      ctx.lineTo(ann.endPoint.x * scale, ann.endPoint.y * scale);
      ctx.stroke();
    } else if (ann.type === 'arrow' && ann.startPoint && ann.endPoint) {
      drawArrow(ctx, ann.startPoint.x * scale, ann.startPoint.y * scale, ann.endPoint.x * scale, ann.endPoint.y * scale, ann.strokeWidth * scale);
    } else if (ann.type === 'rect' && ann.box) {
      ctx.strokeRect(ann.box.x * scale, ann.box.y * scale, (ann.box.width || 100) * scale, (ann.box.height || 60) * scale);
    } else if (ann.type === 'circle' && ann.box) {
      ctx.beginPath();
      const rx = ((ann.box.width || 80) * scale) / 2;
      const ry = ((ann.box.height || 80) * scale) / 2;
      const cx = (ann.box.x * scale) + rx;
      const cy = (ann.box.y * scale) + ry;
      ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (ann.type === 'text' && ann.box && ann.text) {
      const fSize = (ann.fontSize || 18) * scale;
      ctx.font = `${ann.isBold ? 'bold' : 'normal'} ${fSize}px 'Cairo', sans-serif`;
      ctx.fillText(ann.text, ann.box.x * scale, (ann.box.y * scale) + fSize);
    }

    ctx.restore();
  }

  // If rendering for Academic PDF export, stamp academic header and footer
  if (doc && totalPages) {
    ctx.save();
    const currPageNum = page.pageNumber || (pageIndex !== undefined ? pageIndex + 1 : 1);

    // Academic Top Header Bar
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(35, 38);
    ctx.lineTo(canvas.width - 35, 38);
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.font = 'bold 15px "Cairo", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${doc.title}  •  ${doc.grade || ''}`, canvas.width - 40, 28);

    ctx.textAlign = 'left';
    ctx.fillText(`إعداد: ${doc.author || 'معلم المادة'}`, 40, 28);

    // Academic Bottom Footer Bar
    ctx.beginPath();
    ctx.moveTo(35, canvas.height - 35);
    ctx.lineTo(canvas.width - 35, canvas.height - 35);
    ctx.stroke();

    ctx.textAlign = 'right';
    ctx.fillText('منصة قلمي التعليمية • طبعة أكاديمية معتمدة', canvas.width - 40, canvas.height - 16);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#1e3a8a';
    ctx.font = 'bold 16px "Cairo", sans-serif';
    ctx.fillText(`- صفحة ${currPageNum} من ${totalPages} -`, canvas.width / 2, canvas.height - 16);

    ctx.textAlign = 'left';
    ctx.fillStyle = '#64748b';
    ctx.font = '14px "Cairo", sans-serif';
    ctx.fillText(new Date().toLocaleDateString('ar-EG'), 40, canvas.height - 16);

    ctx.restore();
  }

  return canvas;
}

function drawArrow(ctx: CanvasRenderingContext2D, fromx: number, fromy: number, tox: number, toy: number, width: number) {
  const headlen = Math.max(12, width * 3);
  const angle = Math.atan2(toy - fromy, tox - fromx);
  ctx.beginPath();
  ctx.moveTo(fromx, fromy);
  ctx.lineTo(tox, toy);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(tox, toy);
  ctx.lineTo(tox - headlen * Math.cos(angle - Math.PI / 6), toy - headlen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(tox - headlen * Math.cos(angle + Math.PI / 6), toy - headlen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

/**
 * Creates realistic exam paper page 1 (Fifth Grade Arabic, Al-Emtehan Book)
 */
function createExamPage1(): DocumentPage {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 1700;
  const ctx = canvas.getContext('2d')!;

  // Paper background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Border frame
  ctx.strokeStyle = '#0284c7';
  ctx.lineWidth = 4;
  ctx.strokeRect(40, 40, canvas.width - 80, canvas.height - 80);
  ctx.strokeStyle = '#0284c7';
  ctx.lineWidth = 1;
  ctx.strokeRect(46, 46, canvas.width - 92, canvas.height - 92);

  // Header Banner
  ctx.fillStyle = '#0284c7';
  ctx.fillRect(50, 50, canvas.width - 100, 110);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 32px "Cairo", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('كتاب الامتحان • نماذج اختبارات شهر أكتوبر 2026', canvas.width - 90, 100);

  ctx.font = 'bold 22px "Cairo", sans-serif';
  ctx.fillText('المادة: اللغة العربية | الصف الخامس الابتدائي | الفصل الدراسي الأول', canvas.width - 90, 138);

  ctx.textAlign = 'left';
  ctx.font = 'bold 20px "Cairo", sans-serif';
  ctx.fillText('الزمن: ساعة واحدة', 80, 100);
  ctx.fillText('الدرجة: ٣٠ درجة', 80, 138);

  // Student info box
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(60, 175, canvas.width - 120, 60);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.strokeRect(60, 175, canvas.width - 120, 60);

  ctx.fillStyle = '#1e293b';
  ctx.font = 'bold 18px "Cairo", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('اسم الطالب: ................................................................   الفصل: ...................   المدرسة: .......................................', canvas.width - 80, 212);

  // First Section: النص الأدبي المحرر من المحتوى
  drawSectionHeader(ctx, 260, 'أولاً: نص الاستماع والقراءة المتحررة (١٠ درجات)');

  ctx.font = '20px "Cairo", sans-serif';
  ctx.fillStyle = '#334155';
  ctx.fillText('اقرأ الفقرة التالية ثم أجب عن الأسئلة الآتية:', canvas.width - 80, 320);

  // Paragraph Box
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(80, 340, canvas.width - 160, 140);
  ctx.strokeStyle = '#94a3b8';
  ctx.strokeRect(80, 340, canvas.width - 160, 140);

  ctx.fillStyle = '#0f172a';
  ctx.font = '20px "Cairo", sans-serif';
  ctx.fillText('«النجاح لا يأتي مصادفة، بل هو ثمرة الاجتهاد والمثابرة والتخطيط الجيد للوقت. إن الطالب الذي يضع لنفسه', canvas.width - 100, 380);
  ctx.fillText('هدفاً واضحاً ويسعى لتحقيقه بالصبر والإصرار يتغلب على جميع الصعاب التي تواجهه، ويصل إلى أعلى المراتب.', canvas.width - 100, 420);
  ctx.fillText('لذا احرص يا بني على استثمار وقتك في التعلم والمطالعة لتكون نافعاً لنفسك ولوطنك الغالي مصر.»', canvas.width - 100, 460);

  // Questions
  ctx.font = 'bold 20px "Cairo", sans-serif';
  ctx.fillText('(أ) اختر الإجابة الصحيحة مما بين القوسين:', canvas.width - 80, 520);

  ctx.font = '19px "Cairo", sans-serif';
  ctx.fillText('١. مرادف كلمة «المثابرة»: ( المداومة  -  السرعة  -  التردد  -  الانتظار )', canvas.width - 110, 560);
  ctx.fillText('٢. مضاد كلمة «النجاح»: ( الضعف  -  الفشل  -  الكسل  -  اليأس )', canvas.width - 110, 605);

  ctx.font = 'bold 20px "Cairo", sans-serif';
  ctx.fillText('(ب) ضع علامة (✓) أمام العبارة الصحيحة وعلامة (✗) أمام العبارة غير الصحيحة:', canvas.width - 80, 665);

  ctx.font = '19px "Cairo", sans-serif';
  ctx.fillText('١. يأتي النجاح والتفوق في الحياة بالمصادفة دون تخطيط.                 (      )', canvas.width - 110, 710);
  ctx.fillText('٢. التخطيط الجيد واستثمار الوقت من أهم أسباب الوصول إلى القمة.    (      )', canvas.width - 110, 755);

  ctx.font = 'bold 20px "Cairo", sans-serif';
  ctx.fillText('(جـ) ما النصيحة التي وجهها الكاتب في نهاية الفقرة؟', canvas.width - 80, 815);
  ctx.font = '18px "Cairo", sans-serif';
  ctx.fillText('جـ: ..........................................................................................................................................................', canvas.width - 110, 855);

  // Second Section: القواعد النحوية والإملائية
  drawSectionHeader(ctx, 900, 'ثانياً: القواعد النحوية والإملائية (١٠ درجات)');

  ctx.font = '20px "Cairo", sans-serif';
  ctx.fillStyle = '#0f172a';
  ctx.fillText('«كافأ المعلمُ التلميذين المتفوقين في طابور الصباح تقديراً لاجتهادهما»', canvas.width - 100, 960);

  ctx.font = 'bold 20px "Cairo", sans-serif';
  ctx.fillText('(أ) استخرج من الجملة السابقة ما يلي:', canvas.width - 80, 1010);
  ctx.font = '19px "Cairo", sans-serif';
  ctx.fillText('١. فاعلاً: ...............................   علامة إعرابه: .................................................', canvas.width - 110, 1055);
  ctx.fillText('٢. مفعولاً به: ............................   علامة إعرابه: .................................................', canvas.width - 110, 1100);

  ctx.font = 'bold 20px "Cairo", sans-serif';
  ctx.fillText('(ب) صوّب الخطأ النحوي في الجمل التالية واكتبها صحيحة:', canvas.width - 80, 1160);
  ctx.font = '19px "Cairo", sans-serif';
  ctx.fillText('١. قرأ التلميذُ قصتان مفيدتان.                الصواب: .....................................................', canvas.width - 110, 1205);
  ctx.fillText('٢. يتقن المهندسين أعمالهم بإخلاص.         الصواب: .....................................................', canvas.width - 110, 1250);

  ctx.font = 'bold 20px "Cairo", sans-serif';
  ctx.fillText('(جـ) ثَنِّ واجمع الجملة الآتية: «هذا هو المعلم المخلص في عمله»', canvas.width - 80, 1310);
  ctx.font = '18px "Cairo", sans-serif';
  ctx.fillText('المثنى: ...................................................................................................................................................', canvas.width - 110, 1355);
  ctx.fillText('الجمع: ...................................................................................................................................................', canvas.width - 110, 1400);

  // Footer notes
  ctx.strokeStyle = '#e2e8f0';
  ctx.beginPath();
  ctx.moveTo(80, 1550);
  ctx.lineTo(canvas.width - 80, 1550);
  ctx.stroke();

  ctx.fillStyle = '#64748b';
  ctx.font = '16px "Cairo", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('الصفحة ١ من ٢ • كتاب الامتحان في اللغة العربية للصف الخامس الابتدائي • أكتوبر 2026', canvas.width / 2, 1590);

  return {
    id: generateId(),
    pageNumber: 1,
    imageUrl: canvas.toDataURL('image/jpeg', 0.85),
    annotations: [],
    lastEdited: Date.now(),
  };
}

function createExamPage2(): DocumentPage {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 1700;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = '#0284c7';
  ctx.lineWidth = 4;
  ctx.strokeRect(40, 40, canvas.width - 80, canvas.height - 80);
  ctx.strokeStyle = '#0284c7';
  ctx.lineWidth = 1;
  ctx.strokeRect(46, 46, canvas.width - 92, canvas.height - 92);

  // Top bar
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(50, 50, canvas.width - 100, 60);
  ctx.fillStyle = '#0369a1';
  ctx.font = 'bold 22px "Cairo", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('تابع: اختبار شهر أكتوبر في مادة اللغة العربية - الصف الخامس', canvas.width - 80, 88);

  // Section 3: التعبير الكتابي (سيرة غيرية / رسالة)
  drawSectionHeader(ctx, 130, 'ثالثاً: التعبير الكتابي (٥ درجات)');
  ctx.font = '20px "Cairo", sans-serif';
  ctx.fillStyle = '#0f172a';
  ctx.fillText('اكتب «سيرة غيرية» عن شخصية مصرية أثرت في حياتك (مثل د. أحمد زويل أو د. مجدي يعقوب)', canvas.width - 80, 190);
  ctx.fillText('مراعياً العناصر التالية: (الفكرة العامة، معلومات شخصية، أهم الإنجازات، الخاتمة والرأي الشخصي):', canvas.width - 80, 230);

  // Lined writing area
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1.5;
  for (let y = 290; y <= 620; y += 45) {
    ctx.beginPath();
    ctx.moveTo(80, y);
    ctx.lineTo(canvas.width - 80, y);
    ctx.stroke();
  }

  // Section 4: الخط العربي والإملاء
  drawSectionHeader(ctx, 670, 'رابعاً: الخط العربي (٢.٥ درجة)');
  ctx.font = '22px "Cairo", sans-serif';
  ctx.fillStyle = '#0f172a';
  ctx.fillText('اكتب ما يلي بخط النسخ مرة وبخط الرقعة مرة أخرى مع مراعاة الدقة والتشكيل:', canvas.width - 80, 730);

  ctx.fillStyle = '#1e3a8a';
  ctx.font = 'bold 26px "Cairo", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('«مَنْ جَدَّ وَجَدَ، وَمَنْ زَرَعَ حَصَدَ، وَمَنْ سَارَ عَلَى الدَّرْبِ وَصَلَ»', canvas.width / 2, 790);

  ctx.strokeStyle = '#e2e8f0';
  ctx.textAlign = 'right';
  ctx.strokeRect(80, 830, canvas.width - 160, 120);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '18px "Cairo", sans-serif';
  ctx.fillText('خط النسخ: ........................................................................................................................................', canvas.width - 100, 875);
  ctx.fillText('خط الرقعة: ........................................................................................................................................', canvas.width - 100, 925);

  // Section 5: الإملاء
  drawSectionHeader(ctx, 980, 'خامساً: القواعد الإملائية (٢.٥ درجة)');
  ctx.fillStyle = '#0f172a';
  ctx.font = '20px "Cairo", sans-serif';
  ctx.fillText('اختر الكلمة الصحيحة إملائياً مما بين القوسين وضعها مكان النقط:', canvas.width - 80, 1040);

  ctx.font = '19px "Cairo", sans-serif';
  ctx.fillText('١. قرأتُ قصةً عن الصحابي الجليل .................... بن الخطاب. ( عُمر - عَمرو )', canvas.width - 110, 1085);
  ctx.fillText('٢. تتلألأ النجوم في .................... الصافية. ( السَّمَاءُ - السَّمَاءَ - السَّمَاءِ )', canvas.width - 110, 1130);
  ctx.fillText('٣. ما أجمل خلق الصدق والوفاء! علامة الترقيم المناسبة: ( .  /  ؟  /  !  )', canvas.width - 110, 1175);

  // Teacher feedback notes section
  ctx.fillStyle = '#fef3c7';
  ctx.fillRect(80, 1240, canvas.width - 160, 160);
  ctx.strokeStyle = '#f59e0b';
  ctx.strokeRect(80, 1240, canvas.width - 160, 160);

  ctx.fillStyle = '#92400e';
  ctx.font = 'bold 20px "Cairo", sans-serif';
  ctx.fillText('ملاحظات وتوجيهات المعلم / ولي الأمر:', canvas.width - 110, 1280);
  ctx.font = '18px "Cairo", sans-serif';
  ctx.fillText('• استخدم القلم الإلكتروني بألوان مختلفة لتظليل الإجابات النموذجية وكتابة الملاحظات.', canvas.width - 110, 1320);
  ctx.fillText('• يمكنك تصدير الملف كـ PDF بعد الإجابة ومشاركته أو طباعته مباشرة.', canvas.width - 110, 1360);

  ctx.strokeStyle = '#e2e8f0';
  ctx.beginPath();
  ctx.moveTo(80, 1550);
  ctx.lineTo(canvas.width - 80, 1550);
  ctx.stroke();

  ctx.fillStyle = '#64748b';
  ctx.font = '16px "Cairo", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('الصفحة ٢ من ٢ • نهاية اختبار شهر أكتوبر • تمنياتنا لجميع الطلاب بالتفوق والنجاح', canvas.width / 2, 1590);

  return {
    id: generateId(),
    pageNumber: 2,
    imageUrl: canvas.toDataURL('image/jpeg', 0.85),
    annotations: [],
    lastEdited: Date.now(),
  };
}

function drawSectionHeader(ctx: CanvasRenderingContext2D, y: number, title: string) {
  ctx.fillStyle = '#e0f2fe';
  ctx.fillRect(60, y, 1080, 42);
  ctx.fillStyle = '#0369a1';
  ctx.font = 'bold 21px "Cairo", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(title, 1120, y + 28);
}
