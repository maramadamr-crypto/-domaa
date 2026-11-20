import React, { useState, useEffect } from 'react';
import { StudyDocument, StudyReminder, UserProfile, SubjectId } from './types';
import { StorageService } from './services/storage';
import { ReminderService } from './services/reminderService';
import {
  auth,
  logOut,
  isFirebaseConfigured as checkFirebaseConfigured,
  subscribeFirebaseConfig,
  fetchDocumentsFromFirestore,
  fetchPublicDocumentsWithDeletions,
  fetchPublicSyncState,
  fetchVideosFromFirestore,
  fetchQuizzesFromFirestore,
  subscribeToFirestoreDocuments,
  subscribeToFirestoreVideos,
  subscribeToFirestoreQuizzes,
  subscribeToUserReminders,
  syncUserProfile,
  parseRemoteDocumentSnap,
} from './services/firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { StudyProgressService } from './services/studyProgressService';
import { CommentService } from './services/commentService';
import { Navbar } from './components/layout/Navbar';
import { HomeView } from './components/home/HomeView';
import { LibraryView } from './components/library/LibraryView';
import { DocumentViewer } from './components/viewer/DocumentViewer';
import { PublishModal } from './components/publish/PublishModal';
import { RemindersModal } from './components/reminders/RemindersModal';
import { StudyAlarmModal } from './components/reminders/StudyAlarmModal';
import { AuthModal } from './components/auth/AuthModal';
import { UserProfileModal } from './components/profile/UserProfileModal';
import { PublisherProfileModal } from './components/profile/PublisherProfileModal';
import { NotificationCenter } from './components/notifications/NotificationCenter';
import { NotificationPermissionModal } from './components/notifications/NotificationPermissionModal';
import { NotificationService } from './services/notificationService';
import { StudyProgressModal } from './components/analytics/StudyProgressModal';
import { BottomTabBar, MainTabType } from './components/layout/BottomTabBar';
import { ShortsFeedView } from './components/shorts/ShortsFeedView';
import { LessonsCatalogView } from './components/lessons/LessonsCatalogView';
import { PublishChoiceModal } from './components/publish/PublishChoiceModal';
import { PublishVideoModal } from './components/publish/PublishVideoModal';
import { PublishQuizModal } from './components/publish/PublishQuizModal';
import { PeoplePagesSearchModal } from './components/profile/PeoplePagesSearchModal';
import { QuizzesCatalogView } from './components/quizzes/QuizzesCatalogView';
import { VideoService } from './services/videoService';
import { QuizService } from './services/quizService';
import { FirebaseConfigModal } from './components/firebase/FirebaseConfigModal';

export default function App() {
  // 1. Dark Mode State
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('qalami_theme_mode');
    if (saved) return saved === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('qalami_theme_mode', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('qalami_theme_mode', 'light');
    }
  }, [darkMode]);

  const toggleDarkMode = () => setDarkMode((prev) => !prev);

  // Active User Profile State for immediate UI sync
  const [activeProfile, setActiveProfile] = useState<UserProfile>(() => StorageService.getActiveProfile());
  const [viewingPublisherKey, setViewingPublisherKey] = useState<string | null>(null);

  // 2. Documents State
  const [documents, setDocuments] = useState<StudyDocument[]>(() => StorageService.getDocuments());

  // Subscribe to storage updates for instant profile and documents sync (removes deleted open tabs automatically)
  useEffect(() => {
    const unsubscribe = StorageService.subscribe((updatedDocs) => {
      setActiveProfile(StorageService.getActiveProfile());
      setDocuments(updatedDocs);
      setOpenDocuments((prevOpen) =>
        prevOpen
          .map((openDoc) => updatedDocs.find((d) => d.id === openDoc.id))
          .filter((d): d is StudyDocument => Boolean(d))
      );
    });
    return () => unsubscribe();
  }, []);

  // 3. Google Tabs / Open Documents State
  const [openDocuments, setOpenDocuments] = useState<StudyDocument[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'library' | 'viewer'>('library');

  useEffect(() => {
    if (viewMode === 'viewer' && activeDocId && !openDocuments.some((d) => d.id === activeDocId)) {
      if (openDocuments.length > 0) {
        setActiveDocId(openDocuments[openDocuments.length - 1].id);
      } else {
        setActiveDocId(null);
        setViewMode('library');
      }
    }
  }, [openDocuments, activeDocId, viewMode]);

  // 3.5. Bottom Navigation Tabs (الرئيسية 🏠, المذكرات 📚, أسئلة تفاعلية 📝, الدروس 📺, Shorts 🎬)
  const [activeBottomTab, setActiveBottomTab] = useState<MainTabType>('home');
  const [selectedSubjectFilter, setSelectedSubjectFilter] = useState<SubjectId | 'all'>('all');
  const [shortsCount, setShortsCount] = useState<number>(() => VideoService.getShorts().length);
  const [lessonsCount, setLessonsCount] = useState<number>(() => VideoService.getLessons().length);
  const [quizzesCount, setQuizzesCount] = useState<number>(() => QuizService.getAllQuizzes().length);

  useEffect(() => {
    const unsubVideos = VideoService.subscribe(() => {
      setShortsCount(VideoService.getShorts().length);
      setLessonsCount(VideoService.getLessons().length);
    });
    const unsubQuizzes = QuizService.subscribe((list) => {
      setQuizzesCount(list.length);
    });
    return () => {
      unsubVideos();
      unsubQuizzes();
    };
  }, []);

  // 4. Publishing Modals (3 buttons: نشر مذكرة, نشر shorts أو درس, نشر أسئلة تفاعلية)
  const [isPublishChoiceOpen, setIsPublishChoiceOpen] = useState(false);
  const [isPublishModalOpen, setIsPublishModalOpen] = useState(false);
  const [isPublishVideoOpen, setIsPublishVideoOpen] = useState(false);
  const [isPublishQuizOpen, setIsPublishQuizOpen] = useState(false);
  const [isPeopleSearchOpen, setIsPeopleSearchOpen] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isStudyProgressModalOpen, setIsStudyProgressModalOpen] = useState(false);
  const [isFirebaseModalOpen, setIsFirebaseModalOpen] = useState(false);
  const [isFirebaseConfigured, setIsFirebaseConfigured] = useState<boolean>(() => checkFirebaseConfigured());

  useEffect(() => {
    const unsub = subscribeFirebaseConfig(() => {
      setIsFirebaseConfigured(checkFirebaseConfigured());
    });
    return () => unsub();
  }, []);

  // 5. Study Reminders & Alarms State
  const [reminders, setReminders] = useState<StudyReminder[]>(() => ReminderService.getReminders());
  const [isRemindersModalOpen, setIsRemindersModalOpen] = useState(false);
  const [preselectedDocForReminder, setPreselectedDocForReminder] = useState<StudyDocument | null>(null);
  const [activeAlarmReminder, setActiveAlarmReminder] = useState<StudyReminder | null>(null);

  // 6. Notification Center & Permission Modal State
  const [isNotificationCenterOpen, setIsNotificationCenterOpen] = useState(false);
  const [isNotificationPermissionModalOpen, setIsNotificationPermissionModalOpen] = useState(false);
  const [unreadNotificationsCount, setUnreadNotificationsCount] = useState<number>(() => NotificationService.getUnreadCount());

  // Refresh reminders from storage
  const refreshReminders = () => {
    setReminders(ReminderService.getReminders());
  };

  useEffect(() => {
    const handleRemindersUpdated = () => {
      setReminders(ReminderService.getReminders());
    };
    window.addEventListener('qalami_reminders_updated', handleRemindersUpdated);
    return () => window.removeEventListener('qalami_reminders_updated', handleRemindersUpdated);
  }, []);

  // Background timer to check for due study alarms
  useEffect(() => {
    const checkAlarms = () => {
      const dueReminders = ReminderService.checkDueReminders();
      if (dueReminders.length > 0) {
        const topDue = dueReminders[0];
        // Trigger alert tone & browser notification
        ReminderService.triggerNotification(topDue);
        // Display in-app alarm modal
        setActiveAlarmReminder(topDue);
        refreshReminders();
      }
    };

    // Check immediately and every 10 seconds
    checkAlarms();
    const interval = setInterval(checkAlarms, 10000);
    return () => clearInterval(interval);
  }, []);

  // Refresh docs from storage
  const refreshDocuments = () => {
    setDocuments(StorageService.getDocuments());
  };

  // Open Document in Viewer with Google Tabs
  const handleOpenDocument = (doc: StudyDocument) => {
    setOpenDocuments((prev) => (prev.some((d) => d.id === doc.id) ? prev : [...prev, doc]));
    setActiveDocId(doc.id);
    setViewMode('viewer');
    if (!doc.pdfFileId) {
      StorageService.ensureDocumentPagesLoaded(doc.id, 1).catch(() => {});
    }
  };

  // Close Tab
  const handleCloseDocumentTab = (docId: string) => {
    const remaining = openDocuments.filter((d) => d.id !== docId);
    setOpenDocuments(remaining);

    if (activeDocId === docId) {
      if (remaining.length > 0) {
        setActiveDocId(remaining[remaining.length - 1].id);
      } else {
        setActiveDocId(null);
        setViewMode('library');
      }
    }
  };

  // Toast Notification State
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((current) => (current === msg ? null : current));
    }, 2800);
  };

  // 6. Firebase Authentication State & Cross-Device Cloud Data Sync (Works with OR without Email Login)
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  // Unconditional Public Cross-Device Sync (Firestore Public Read + Zero-Login Public Relay)
  useEffect(() => {
    let cancelled = false;
    let unsubDocs: (() => void) | null = null;
    let unsubVideos: (() => void) | null = null;
    let unsubQuizzes: (() => void) | null = null;

    const pullPublicServer = async () => {
      try {
        const [pubDocsRes, pubSync] = await Promise.all([
          fetchPublicDocumentsWithDeletions(),
          fetchPublicSyncState(),
        ]);
        if (cancelled) return;

        StorageService.reconcileDeletedDocuments(pubDocsRes.deletedDocIds);
        VideoService.reconcileDeletedVideos(pubSync.deletedVideoIds);
        QuizService.reconcileDeletedQuizzes(pubSync.deletedQuizIds);
        CommentService.reconcileDeletedComments(pubSync.deletedCommentIds);
        ReminderService.reconcileDeletedReminders(pubSync.deletedReminderIds);

        if (pubDocsRes.documents.length > 0) {
          StorageService.mergeCloudDocuments(pubDocsRes.documents);
        }
        if (pubSync.videos.length > 0) {
          VideoService.mergeCloudVideos(pubSync.videos);
        }
        if (pubSync.quizzes.length > 0) {
          QuizService.mergeCloudQuizzes(pubSync.quizzes);
        }
        if (pubSync.comments.length > 0) {
          CommentService.mergePublicComments(pubSync.comments);
        }
      } catch {
        // ignore
      }
    };

    (async () => {
      await StorageService.init();
      if (cancelled) return;

      // 1. Fetch remote state & deletion tombstones FIRST before pushing any local items back up
      const [pubDocsRes, pubSync, cloudDocs, cloudVideos, cloudQuizzes] = await Promise.all([
        fetchPublicDocumentsWithDeletions(),
        fetchPublicSyncState(),
        fetchDocumentsFromFirestore(),
        fetchVideosFromFirestore(),
        fetchQuizzesFromFirestore(),
      ]);
      if (cancelled) return;

      // 2. Apply all deletions before merging or pushing anything
      StorageService.reconcileDeletedDocuments(pubDocsRes.deletedDocIds);
      VideoService.reconcileDeletedVideos(pubSync.deletedVideoIds);
      QuizService.reconcileDeletedQuizzes(pubSync.deletedQuizIds);
      CommentService.reconcileDeletedComments(pubSync.deletedCommentIds);
      ReminderService.reconcileDeletedReminders(pubSync.deletedReminderIds);

      // 3. Merge active remote items
      StorageService.mergeCloudDocuments([...pubDocsRes.documents, ...cloudDocs]);
      VideoService.mergeCloudVideos([...pubSync.videos, ...cloudVideos]);
      QuizService.mergeCloudQuizzes([...pubSync.quizzes, ...cloudQuizzes]);
      CommentService.mergePublicComments(pubSync.comments);

      // 4. Only now sync surviving local items to the zero-login public relay
      StorageService.syncLocalDocsToPublicServer();
      VideoService.syncLocalVideosToPublicServer();
      QuizService.syncLocalQuizzesToPublicServer();

      // Attach live Firestore subscriptions unconditionally (no login required to read)
      try {
        unsubDocs = subscribeToFirestoreDocuments((docs, removedIds) => {
          if (removedIds && removedIds.length > 0) {
            StorageService.reconcileDeletedDocuments(removedIds);
          }
          StorageService.mergeCloudDocuments(docs);
        });
      } catch {
        // ignore if offline
      }
      try {
        unsubVideos = subscribeToFirestoreVideos((videos, removedIds) => {
          if (removedIds && removedIds.length > 0) {
            VideoService.reconcileDeletedVideos(removedIds);
          }
          VideoService.mergeCloudVideos(videos);
        });
      } catch {
        // ignore
      }
      try {
        unsubQuizzes = subscribeToFirestoreQuizzes((quizzes, removedIds) => {
          if (removedIds && removedIds.length > 0) {
            QuizService.reconcileDeletedQuizzes(removedIds);
          }
          QuizService.mergeCloudQuizzes(quizzes);
        });
      } catch {
        // ignore
      }
    })();

    let eventSource: EventSource | null = null;
    if (typeof EventSource !== 'undefined') {
      try {
        eventSource = new EventSource('/api/public-documents/stream');
        eventSource.onmessage = (ev) => {
          if (cancelled || !ev.data) return;
          try {
            const payload = JSON.parse(ev.data);
            if (payload?.type === 'doc_updated' && payload.doc) {
              StorageService.mergeCloudDocuments([parseRemoteDocumentSnap(payload.doc)]);
            } else if (
              payload?.type === 'pages_updated' &&
              typeof payload.docId === 'string' &&
              Array.isArray(payload.pageNumbers)
            ) {
              StorageService.hydrateSpecificPages(payload.docId, payload.pageNumbers).catch(() => {});
            } else if (payload?.type === 'doc_deleted' && typeof payload.docId === 'string') {
              StorageService.removeRemoteDeletedDocument(payload.docId);
            } else if (payload?.type === 'video_updated' && payload.video) {
              VideoService.mergeCloudVideos([payload.video]);
            } else if (payload?.type === 'video_deleted' && typeof payload.videoId === 'string') {
              VideoService.reconcileDeletedVideos([payload.videoId]);
            } else if (payload?.type === 'quiz_updated' && payload.quiz) {
              QuizService.mergeCloudQuizzes([payload.quiz]);
            } else if (payload?.type === 'quiz_deleted' && typeof payload.quizId === 'string') {
              QuizService.reconcileDeletedQuizzes([payload.quizId]);
            } else if (payload?.type === 'comment_updated' && payload.comment) {
              CommentService.mergePublicComments([payload.comment]);
            } else if (payload?.type === 'comment_deleted' && typeof payload.commentId === 'string') {
              CommentService.reconcileDeletedComments(
                [payload.commentId],
                typeof payload.targetId === 'string' ? payload.targetId : undefined
              );
            } else if (payload?.type === 'reminder_deleted' && typeof payload.reminderId === 'string') {
              ReminderService.reconcileDeletedReminders([payload.reminderId]);
            }
          } catch {
            // ignore malformed SSE packet
          }
        };
      } catch {
        eventSource = null;
      }
    }

    const handleVisibilityOrFocus = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        pullPublicServer();
      }
    };
    window.addEventListener('focus', handleVisibilityOrFocus);
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);

    const pollTimer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        pullPublicServer();
      }
    }, 15000);

    return () => {
      cancelled = true;
      if (eventSource) eventSource.close();
      window.removeEventListener('focus', handleVisibilityOrFocus);
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      clearInterval(pollTimer);
      if (unsubDocs) unsubDocs();
      if (unsubVideos) unsubVideos();
      if (unsubQuizzes) unsubQuizzes();
    };
  }, []);

  // Auth-specific user profile & private reminders sync
  useEffect(() => {
    let unsubReminders: (() => void) | null = null;

    const cleanupReminders = () => {
      if (unsubReminders) {
        unsubReminders();
        unsubReminders = null;
      }
    };

    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      cleanupReminders();

      if (user) {
        // 1. Sync Firebase user profile with active local profile
        syncUserProfile(user)
          .then((fbProfile) => {
            try {
              localStorage.setItem('qalami_active_profile_v1', user.uid);
            } catch {
              // ignore
            }
            const synced = StorageService.updateActiveProfile({
              id: user.uid,
              name: fbProfile.name || user.displayName || 'طالب متميز',
              photoURL: fbProfile.photoURL || user.photoURL || '',
              role: fbProfile.role || 'student',
              grade: fbProfile.grade || 'الصف الخامس الابتدائي',
              bio: fbProfile.bio || '',
              avatarColor: fbProfile.avatarColor || 'from-amber-500 to-orange-600',
            });
            setActiveProfile(synced);
          })
          .catch(() => {});

        // 2. Attach user reminders subscription
        unsubReminders = subscribeToUserReminders(user.uid, (cloudReminders, removedIds) => {
          ReminderService.mergeCloudReminders(cloudReminders, removedIds);
        });

        // 3. Push any local/guest data created before sign-in & load user study progress
        StorageService.init()
          .then(() => {
            StorageService.syncLocalDocsToFirestore();
          })
          .catch(() => {});
        VideoService.syncLocalVideosToFirestore();
        QuizService.syncLocalQuizzesToFirestore();
        ReminderService.syncLocalRemindersToFirestore();
        StudyProgressService.loadFromCloud(user.uid).catch(() => {});
      }
    });

    return () => {
      unsubscribeAuth();
      cleanupReminders();
    };
  }, []);

  const handleGoogleSignOut = async () => {
    try {
      await logOut();
      try {
        localStorage.removeItem('qalami_active_profile_v1');
      } catch {
        // ignore
      }
      setActiveProfile(StorageService.getActiveProfile());
      showToast('تم تسجيل الخروج بنجاح 👋');
    } catch (err) {
      console.error(err);
    }
  };

  // Select Tab
  const handleSelectDocumentTab = (docId: string) => {
    setActiveDocId(docId);
  };

  // Immediate Delete Document (مسح فوري دون انتظار)
  const handleDeleteDocument = (docId: string) => {
    StorageService.deleteDocument(docId);
    setDocuments((prev) => prev.filter((d) => d.id !== docId));
    handleCloseDocumentTab(docId);
    showToast('تم مسح المذكرة فوراً من مكتبتك 🗑️');
  };

  // Toggle Favorite
  const handleToggleFavorite = (docId: string) => {
    StorageService.toggleFavorite(docId);
    refreshDocuments();
  };

  // Document Created Callback
  const handleDocumentCreated = (newDoc: StudyDocument) => {
    refreshDocuments();
    handleOpenDocument(newDoc);
    showToast('تم نشر المذكرة بنجاح في مكتبة الصف الخامس ✨');
  };

  // Load Sample Exam (5th Grade Arabic - Al-Emtehan)
  const handleLoadSampleExam = () => {
    const sample = StorageService.createSampleArabicExam('grade_5_student');
    StorageService.saveDocument(sample);
    refreshDocuments();
    handleOpenDocument(sample);
    showToast('تم تحميل نموذج اختبارات كتاب الامتحان للصف الخامس بنجاح 📚');
  };

  // Reminder Handlers
  const handleOpenRemindersModal = () => {
    setPreselectedDocForReminder(null);
    setIsRemindersModalOpen(true);
  };

  const handleOpenReminderForDoc = (doc: StudyDocument) => {
    setPreselectedDocForReminder(doc);
    setIsRemindersModalOpen(true);
  };

  const handleSnoozeReminder = (reminderId: string, minutes: number = 5) => {
    ReminderService.snoozeReminder(reminderId, minutes);
    setActiveAlarmReminder(null);
    refreshReminders();
    showToast(`تم تأجيل تنبيه المذاكرة ${minutes} دقائق ⏱️`);
  };

  const handleCompleteReminder = (reminderId: string) => {
    ReminderService.toggleCompleted(reminderId);
    setActiveAlarmReminder(null);
    refreshReminders();
    showToast('أحسنت يا بطل! تم إنجاز مراجعة المادة بنجاح 🌟');
  };

  const handleQuickToggleReminderComplete = (reminderId: string) => {
    const isDone = ReminderService.toggleCompleted(reminderId);
    refreshReminders();
    if (isDone) {
      showToast('تم إنجاز المراجعة بنجاح! أحسنت 🌟');
    }
  };

  const handleOpenDocById = (docId: string) => {
    const doc = documents.find((d) => d.id === docId);
    if (doc) {
      handleOpenDocument(doc);
    }
  };

  const activeRemindersCount = reminders.filter((r) => r.isActive && !r.isCompleted).length;

  // Currently Active Document in Viewer
  const activeDocument = openDocuments.find((d) => d.id === activeDocId) || documents.find((d) => d.id === activeDocId);

  return (
    <div className="min-h-screen bg-white dark:bg-[#060913] text-slate-900 dark:text-slate-100 flex flex-col font-['Cairo',sans-serif] selection:bg-amber-400 selection:text-slate-950 transition-colors duration-200">
      {/* Toast Notification Banner */}
      {toastMessage && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-slate-900 dark:bg-amber-400 text-white dark:text-slate-950 px-4 py-2 rounded-2xl shadow-xl text-xs font-black flex items-center gap-2 border border-slate-700 dark:border-amber-500 animate-in fade-in slide-in-from-top duration-200">
          <span>{toastMessage}</span>
        </div>
      )}


      {/* Show Navbar when in library/feed/home mode */}
      {viewMode === 'library' && (
        <Navbar
          darkMode={darkMode}
          onToggleDarkMode={toggleDarkMode}
          onOpenPublishModal={() => setIsPublishChoiceOpen(true)}
          onOpenRemindersModal={handleOpenRemindersModal}
          onOpenPeopleSearch={() => setIsPeopleSearchOpen(true)}
          onOpenStudyProgress={() => setIsStudyProgressModalOpen(true)}
          onOpenFirebaseModal={() => setIsFirebaseModalOpen(true)}
          isFirebaseConfigured={isFirebaseConfigured}
          totalDocsCount={documents.length}
          activeRemindersCount={activeRemindersCount}
          currentUser={currentUser}
          activeProfile={activeProfile}
          onSignIn={() => setIsAuthModalOpen(true)}
          onSignOut={handleGoogleSignOut}
          onOpenProfile={() => setIsProfileModalOpen(true)}
          onOpenMyProfile={() => setViewingPublisherKey(activeProfile.id || activeProfile.name)}
          onOpenNotifications={() => setIsNotificationCenterOpen(true)}
          onOpenNotificationPermission={() => setIsNotificationPermissionModalOpen(true)}
          unreadNotificationsCount={unreadNotificationsCount}
          onNavigateHome={() => {
            setViewMode('library');
            setActiveBottomTab('home');
          }}
        />
      )}

      {/* Main Content Router */}
      <div id="main-layout" className={`flex-1 ${viewMode !== 'viewer' ? 'pb-20' : ''}`}>
        {viewMode === 'viewer' && activeDocument ? (
          <DocumentViewer
            initialDocument={activeDocument}
            openDocuments={openDocuments}
            activeDocId={activeDocId!}
            onSelectDocument={handleSelectDocumentTab}
            onCloseDocument={handleCloseDocumentTab}
            onBackToLibrary={() => setViewMode('library')}
            onOpenPublishModal={() => setIsPublishChoiceOpen(true)}
            onDeleteDocument={handleDeleteDocument}
            darkMode={darkMode}
            onToggleDarkMode={toggleDarkMode}
            onOpenReminderForDoc={handleOpenReminderForDoc}
          />
        ) : activeBottomTab === 'home' ? (
          <HomeView
            onNavigateTab={(tab) => {
              setActiveBottomTab(tab);
            }}
            onOpenPublishModal={() => setIsPublishChoiceOpen(true)}
            onOpenDocument={handleOpenDocument}
            documents={documents}
            currentUser={currentUser}
            onSelectSubject={(subjId) => {
              setSelectedSubjectFilter(subjId);
              setActiveBottomTab('documents');
            }}
            onOpenStudyProgress={() => setIsStudyProgressModalOpen(true)}
            onOpenReminders={handleOpenRemindersModal}
          />
        ) : activeBottomTab === 'shorts' ? (
          <ShortsFeedView
            onOpenPublishVideo={() => setIsPublishVideoOpen(true)}
            onOpenPublisherProfile={(key) => setViewingPublisherKey(key)}
          />
        ) : activeBottomTab === 'lessons' ? (
          <LessonsCatalogView
            onOpenPublishVideo={() => setIsPublishVideoOpen(true)}
            onOpenPublisherProfile={(key) => setViewingPublisherKey(key)}
          />
        ) : activeBottomTab === 'quizzes' ? (
          <QuizzesCatalogView
            onOpenPublishQuiz={() => setIsPublishQuizOpen(true)}
            onOpenPublisherProfile={(key) => setViewingPublisherKey(key)}
          />
        ) : (
          <LibraryView
            documents={documents}
            initialSubject={selectedSubjectFilter}
            onOpenDocument={handleOpenDocument}
            onOpenPublishModal={() => setIsPublishChoiceOpen(true)}
            onDeleteDocument={handleDeleteDocument}
            onToggleFavorite={handleToggleFavorite}
            onLoadSampleExam={handleLoadSampleExam}
            reminders={reminders}
            onOpenRemindersModal={handleOpenRemindersModal}
            onQuickToggleComplete={handleQuickToggleReminderComplete}
            currentUser={currentUser}
            onDocumentUpdated={() => refreshDocuments()}
            onOpenPublisherProfile={(key) => setViewingPublisherKey(key)}
            onOpenEditProfile={() => setIsProfileModalOpen(true)}
            onOpenStudyProgress={() => setIsStudyProgressModalOpen(true)}
          />
        )}
      </div>

      {/* Bottom Navigation Tabs (Shorts 🎬, دروس 📺, أسئلة تفاعلية 📝, المذكرات 📚) */}
      {viewMode !== 'viewer' && (
        <BottomTabBar
          activeTab={activeBottomTab}
          onTabChange={setActiveBottomTab}
          shortsCount={shortsCount}
          lessonsCount={lessonsCount}
          quizzesCount={quizzesCount}
          documentsCount={documents.length}
        />
      )}

      {/* 3 Publish Choice Modal (نشر مذكرة، نشر shorts أو درس، نشر أسئلة تفاعلية) */}
      <PublishChoiceModal
        isOpen={isPublishChoiceOpen}
        onClose={() => setIsPublishChoiceOpen(false)}
        onChooseBooklet={() => {
          setIsPublishChoiceOpen(false);
          setIsPublishModalOpen(true);
        }}
        onChooseVideo={() => {
          setIsPublishChoiceOpen(false);
          setIsPublishVideoOpen(true);
        }}
        onChooseQuiz={() => {
          setIsPublishChoiceOpen(false);
          setIsPublishQuizOpen(true);
        }}
      />

      {/* 1. Publish Booklet/Document Modal */}
      <PublishModal
        isOpen={isPublishModalOpen}
        onClose={() => setIsPublishModalOpen(false)}
        onDocumentCreated={handleDocumentCreated}
      />

      {/* 2. Publish Shorts / Video Lesson Modal (Mobile Camera + Filters + Flashlight + Upload) */}
      <PublishVideoModal
        isOpen={isPublishVideoOpen}
        onClose={() => setIsPublishVideoOpen(false)}
        initialType={activeBottomTab === 'lessons' ? 'lesson' : 'shorts'}
        onVideoPublished={(newVideo) => {
          if (newVideo.type === 'shorts') {
            setActiveBottomTab('shorts');
            showToast(`تم نشر Shorts بنجاح! تم التحويل لقسم فيديوهات Shorts 🎬 ✨`);
          } else {
            setActiveBottomTab('lessons');
            showToast(`تم نشر الدرس بنجاح! تم التحويل لقسم الدروس والشروحات 📺 ✨`);
          }
        }}
      />

      {/* 3. Publish Interactive Questions Modal (Questions with time limits, + button for answers, "خلصت" button) */}
      <PublishQuizModal
        isOpen={isPublishQuizOpen}
        onClose={() => setIsPublishQuizOpen(false)}
        onQuizPublished={(newQuiz) => {
          showToast(`تم نشر بنك الأسئلة التفاعلي بنجاح: ${newQuiz.title} 📝`);
        }}
      />

      {/* People Pages Search Modal (دليل والبحث في أي اسم صفحة شخص) */}
      <PeoplePagesSearchModal
        isOpen={isPeopleSearchOpen}
        onClose={() => setIsPeopleSearchOpen(false)}
        onSelectPerson={(key) => setViewingPublisherKey(key)}
        onOpenMyProfile={() => setViewingPublisherKey(activeProfile.id || activeProfile.name)}
      />

      {/* Study Reminders Management Modal */}
      <RemindersModal
        isOpen={isRemindersModalOpen}
        onClose={() => {
          setIsRemindersModalOpen(false);
          setPreselectedDocForReminder(null);
        }}
        documents={documents}
        onOpenDocument={handleOpenDocument}
        preselectedDoc={preselectedDocForReminder}
        onReminderChanged={refreshReminders}
      />

      {/* In-App Study Alarm Modal (When a reminder hits) */}
      <StudyAlarmModal
        reminder={activeAlarmReminder}
        onClose={() => setActiveAlarmReminder(null)}
        onSnooze={handleSnoozeReminder}
        onComplete={handleCompleteReminder}
        onOpenDocument={handleOpenDocById}
      />

      {/* Authentication Modal (Google & Email/Password) */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        onSuccess={() => {
          showToast('تم تسجيل الدخول بنجاح! مرحباً بك 🌟');
        }}
      />

      {/* User Account Edit Modal (Change Name, Photo, Grade, Role) */}
      <UserProfileModal
        isOpen={isProfileModalOpen}
        onClose={() => setIsProfileModalOpen(false)}
        currentUser={currentUser}
        onProfileUpdated={(updated) => {
          setActiveProfile(updated);
          showToast(`تم حفظ وتحديث حسابك: ${updated.name} ✨`);
        }}
      />

      {/* Public Profile Modal for any user or publisher */}
      {viewingPublisherKey && (
        <PublisherProfileModal
          isOpen={!!viewingPublisherKey}
          onClose={() => setViewingPublisherKey(null)}
          publisherKey={viewingPublisherKey}
          allDocuments={documents}
          onOpenDocument={handleOpenDocument}
          onOpenPublishModal={() => setIsPublishChoiceOpen(true)}
          onOpenEditProfile={() => setIsProfileModalOpen(true)}
          currentUserId={currentUser?.uid || activeProfile.id}
          currentUserName={currentUser?.displayName || activeProfile.name}
          onDeleteDocument={handleDeleteDocument}
        />
      )}

      {/* Notifications Center Modal (تفعيل وإدارة إشعارات الموقع للمذاكرة) */}
      <NotificationCenter
        isOpen={isNotificationCenterOpen}
        onClose={() => {
          setIsNotificationCenterOpen(false);
          setUnreadNotificationsCount(NotificationService.getUnreadCount());
        }}
        onOpenReminders={handleOpenRemindersModal}
        onSelectDoc={handleOpenDocById}
      />

      {/* Notification Permission Modal (سماح بالإشعارات أو حظر الموقع) */}
      <NotificationPermissionModal
        isOpen={isNotificationPermissionModalOpen}
        onClose={() => setIsNotificationPermissionModalOpen(false)}
        onPermissionChanged={() => {
          setUnreadNotificationsCount(NotificationService.getUnreadCount());
        }}
      />

      {/* Weekly Study Progress & Analytics Modal (Recharts) */}
      <StudyProgressModal
        isOpen={isStudyProgressModalOpen}
        onClose={() => setIsStudyProgressModalOpen(false)}
      />

      {/* Firebase Configuration & Connection Modal */}
      <FirebaseConfigModal
        isOpen={isFirebaseModalOpen}
        onClose={() => setIsFirebaseModalOpen(false)}
        currentUser={currentUser}
        onOpenAuth={() => setIsAuthModalOpen(true)}
        onSuccess={() => {
          showToast('تم حفظ وتحديث إعدادات Firebase بنجاح! 🔥');
        }}
      />
    </div>
  );
}
