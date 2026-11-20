import React, { useState, useEffect } from 'react';
import {
  X,
  Flame,
  Key,
  Globe,
  CheckCircle2,
  AlertCircle,
  RotateCcw,
  ExternalLink,
  Eye,
  EyeOff,
  Zap,
  RefreshCw,
  Database,
  ShieldCheck,
  UserCheck,
  CloudUpload,
  ClipboardPaste,
} from 'lucide-react';
import { User } from 'firebase/auth';
import {
  getFirebaseSettings,
  isFirebaseConfigured,
  testFirebaseConnection,
  saveFirebaseSettings,
  resetFirebaseSettingsToDefault,
  parseFirebaseConfigSnippet,
  syncUserProfile,
} from '../../services/firebase';
import { StorageService } from '../../services/storage';
import { VideoService } from '../../services/videoService';
import { QuizService } from '../../services/quizService';
import { ReminderService } from '../../services/reminderService';
import { StudyProgressService } from '../../services/studyProgressService';

interface FirebaseConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  currentUser?: User | null;
  onOpenAuth?: () => void;
}

export const FirebaseConfigModal: React.FC<FirebaseConfigModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  currentUser,
  onOpenAuth,
}) => {
  const [projectId, setProjectId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [authDomain, setAuthDomain] = useState('');
  const [appId, setAppId] = useState('');
  const [firestoreDatabaseId, setFirestoreDatabaseId] = useState('(default)');
  const [storageBucket, setStorageBucket] = useState('');
  const [messagingSenderId, setMessagingSenderId] = useState('');
  const [rawSnippet, setRawSnippet] = useState('');
  const [showPasteBox, setShowPasteBox] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncingAll, setIsSyncingAll] = useState(false);
  const [isCustom, setIsCustom] = useState(false);
  const [isCurrentlyConfigured, setIsCurrentlyConfigured] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  const localCounts = isOpen
    ? {
        docs: StorageService.getDocuments().length,
        videos: VideoService.getAllVideos().filter(
          (v) => v.id !== 'demo_short_01' && v.id !== 'demo_lesson_01'
        ).length,
        quizzes: QuizService.getAllQuizzes().length,
        reminders: ReminderService.getReminders().length,
      }
    : { docs: 0, videos: 0, quizzes: 0, reminders: 0 };

  useEffect(() => {
    if (isOpen) {
      const cfg = getFirebaseSettings();
      setProjectId(cfg.projectId || '');
      setApiKey(cfg.apiKey || '');
      setAuthDomain(cfg.authDomain || '');
      setAppId(cfg.appId || '');
      setFirestoreDatabaseId(cfg.firestoreDatabaseId || '(default)');
      setStorageBucket(cfg.storageBucket || '');
      setMessagingSenderId(cfg.messagingSenderId || '');
      setIsCustom(Boolean(cfg.isCustom));
      setIsCurrentlyConfigured(isFirebaseConfigured());
      setStatusMessage(null);
      setShowKey(false);
      setShowPasteBox(false);
      setRawSnippet('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleApplySnippet = () => {
    const parsed = parseFirebaseConfigSnippet(rawSnippet);
    if (!parsed || (!parsed.projectId && !parsed.apiKey)) {
      setStatusMessage({
        type: 'error',
        text: 'تعذر استخراج البيانات من النص الملصوق. تأكد من لصق كود firebaseConfig الصحيح.',
      });
      return;
    }
    if (parsed.projectId) setProjectId(parsed.projectId);
    if (parsed.apiKey) setApiKey(parsed.apiKey);
    if (parsed.authDomain) setAuthDomain(parsed.authDomain);
    if (parsed.appId) setAppId(parsed.appId);
    if (parsed.firestoreDatabaseId) setFirestoreDatabaseId(parsed.firestoreDatabaseId);
    if (parsed.storageBucket) setStorageBucket(parsed.storageBucket);
    if (parsed.messagingSenderId) setMessagingSenderId(parsed.messagingSenderId);
    setShowPasteBox(false);
    setRawSnippet('');
    setStatusMessage({
      type: 'info',
      text: 'تم تعبئة حقول Firebase تلقائياً! اضغط «حفظ الإعدادات والربط» لتفعيلها.',
    });
  };

  const handleTestConnection = async () => {
    setStatusMessage(null);
    setIsLoading(true);
    try {
      const res = await testFirebaseConnection({
        projectId,
        apiKey,
        authDomain,
        appId,
        firestoreDatabaseId,
        storageBucket,
        messagingSenderId,
      });
      setStatusMessage({
        type: res.success ? 'success' : 'error',
        text: res.latencyMs ? `${res.message} (${res.latencyMs}ms)` : res.message,
      });
    } catch (err: any) {
      setStatusMessage({
        type: 'error',
        text: err?.message || 'حدث خطأ أثناء فحص الاتصال بـ Firebase',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSyncAllToFirebase = async () => {
    setStatusMessage(null);
    setIsSyncingAll(true);
    try {
      const conn = await testFirebaseConnection({
        projectId,
        apiKey,
        authDomain,
        appId,
        firestoreDatabaseId,
        storageBucket,
        messagingSenderId,
      });
      if (!conn.success) {
        setStatusMessage({ type: 'error', text: conn.message });
        return;
      }

      if (!currentUser) {
        StorageService.syncLocalDocsToPublicServer();
        setStatusMessage({
          type: 'info',
          text: 'يرجى تسجيل الدخول بحسابك لحفظ المذكرات والتنبيهات والفيديوهات وتقدم المذاكرة في قاعدة بيانات Firebase الخاصة بك.',
        });
        return;
      }

      await syncUserProfile(currentUser).catch(() => {});
      await StorageService.init();
      StorageService.syncLocalDocsToFirestore();
      VideoService.syncLocalVideosToFirestore();
      QuizService.syncLocalQuizzesToFirestore();
      ReminderService.syncLocalRemindersToFirestore();
      StudyProgressService.saveData(StudyProgressService.getData());

      setStatusMessage({
        type: 'success',
        text: `تم حفظ ومزامنة جميع بياناتك في Firebase بنجاح ✅ (${localCounts.docs} مذكرة، ${localCounts.videos} فيديو، ${localCounts.quizzes} اختبار، ${localCounts.reminders} تنبيه)`,
      });
      onSuccess?.();
    } catch (err: any) {
      setStatusMessage({
        type: 'error',
        text: err?.message || 'تعذر مزامنة البيانات مع Firebase حالياً.',
      });
    } finally {
      setIsSyncingAll(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage(null);
    setIsLoading(true);

    try {
      const res = await saveFirebaseSettings({
        projectId,
        apiKey,
        authDomain,
        appId,
        firestoreDatabaseId,
        storageBucket,
        messagingSenderId,
      });

      if (res.success) {
        setStatusMessage({ type: 'success', text: res.message });
        setIsCurrentlyConfigured(true);
        setTimeout(() => {
          onSuccess?.();
          onClose();
          if (res.needsReload) {
            window.location.reload();
          }
        }, 900);
      } else {
        setStatusMessage({ type: 'error', text: res.message });
      }
    } catch (err: any) {
      setStatusMessage({
        type: 'error',
        text: err?.message || 'تعذر حفظ إعدادات Firebase',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetDefault = () => {
    const { needsReload } = resetFirebaseSettingsToDefault();
    const cfg = getFirebaseSettings();
    setProjectId(cfg.projectId);
    setApiKey(cfg.apiKey);
    setAuthDomain(cfg.authDomain);
    setAppId(cfg.appId);
    setFirestoreDatabaseId(cfg.firestoreDatabaseId);
    setStorageBucket(cfg.storageBucket);
    setMessagingSenderId(cfg.messagingSenderId || '');
    setIsCustom(false);
    setIsCurrentlyConfigured(isFirebaseConfigured());
    setStatusMessage({
      type: 'info',
      text: 'تمت استعادة إعدادات مشروع Firebase الافتراضية للمنصة بنجاح.',
    });
    if (needsReload) {
      setTimeout(() => window.location.reload(), 700);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-xs font-['Cairo',sans-serif] animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-lg bg-white dark:bg-[#0c1222] rounded-3xl shadow-2xl border border-slate-200 dark:border-[#1a233a] overflow-hidden text-slate-900 dark:text-slate-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-5 sm:p-6 bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600 text-slate-950 relative">
          <button
            type="button"
            onClick={onClose}
            className="absolute left-4 top-4 p-2 rounded-xl bg-black/10 hover:bg-black/20 text-slate-950 transition cursor-pointer"
            title="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-2 mb-1.5">
            <span className="p-2 rounded-xl bg-white/30 backdrop-blur-xs">
              <Flame className="w-5 h-5 stroke-[2.5] text-slate-950" />
            </span>
            <span className="text-[11px] font-black uppercase tracking-wider bg-black/10 px-2.5 py-0.5 rounded-full">
              إعدادات الربط السحابي
            </span>
          </div>

          <h3 className="text-lg sm:text-xl font-black flex items-center gap-2">
            <span>إعدادات قاعدة بيانات Firebase</span>
            <Zap className="w-5 h-5 text-slate-950 fill-slate-950" />
          </h3>
          <p className="text-xs text-slate-900/85 font-bold mt-1 leading-relaxed">
            فحص الاتصال وتخصيص بيانات مشروع Firebase (Firestore &amp; Authentication) لحفظ المذكرات والملاحظات سحابياً.
          </p>
        </div>

        {/* Content Body */}
        <div className="p-5 sm:p-6 space-y-4 max-h-[80vh] overflow-y-auto">
          {/* Status Indicator */}
          <div className="flex items-center justify-between gap-2 p-3 rounded-2xl bg-slate-100 dark:bg-[#131b2e] border border-slate-200 dark:border-[#1e2a45]">
            <div className="flex items-center gap-2">
              <div
                className={`w-3 h-3 rounded-full shrink-0 ${
                  isCurrentlyConfigured ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'
                }`}
              />
              <div>
                <span className="text-xs font-black block">
                  حالة الربط: {isCurrentlyConfigured ? 'متصل سحابياً بـ Firebase ✅' : 'غير مهيأ بعد ⚠️'}
                </span>
                <span className="text-[10px] text-slate-500 dark:text-slate-400">
                  {isCustom ? 'إعدادات مخصصة لمشروعك' : 'المشروع المدمج الافتراضي للمنصة'}
                </span>
              </div>
            </div>

            {isCustom && (
              <button
                type="button"
                onClick={handleResetDefault}
                className="text-[11px] font-bold text-amber-700 hover:text-amber-800 dark:text-amber-400 flex items-center gap-1 cursor-pointer shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>استعادة الافتراضي</span>
              </button>
            )}
          </div>

          {/* Auth & Sync Summary + One-click Cloud Backup */}
          <div className="p-3.5 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 space-y-2.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <UserCheck className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                <span className="font-bold text-slate-700 dark:text-slate-200 truncate">
                  {currentUser
                    ? `الحساب النشط: ${currentUser.displayName || currentUser.email || 'متصل'}`
                    : 'سجّل الدخول لحفظ بياناتك بشكل دائم في حسابك على Firebase'}
                </span>
              </div>
              {!currentUser && onOpenAuth && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenAuth();
                  }}
                  className="px-2.5 py-1 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-[11px] shrink-0 cursor-pointer"
                >
                  تسجيل الدخول
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-amber-200/70 dark:border-amber-800/40">
              <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                البيانات المحفوظة: {localCounts.docs} مذكرة • {localCounts.quizzes} اختبار • {localCounts.reminders} تنبيه
              </span>
              <button
                type="button"
                onClick={handleSyncAllToFirebase}
                disabled={isSyncingAll || isLoading}
                className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-black text-[11px] flex items-center gap-1.5 shadow-xs transition active:scale-95 disabled:opacity-50 cursor-pointer"
              >
                {isSyncingAll ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <CloudUpload className="w-3.5 h-3.5" />
                )}
                <span>حفظ ومزامنة البيانات إلى Firebase</span>
              </button>
            </div>
          </div>

          {/* Feedback Message */}
          {statusMessage && (
            <div
              className={`p-3 rounded-2xl text-xs font-bold flex items-center gap-2 ${
                statusMessage.type === 'success'
                  ? 'bg-emerald-50 dark:bg-[#06241b] text-emerald-700 dark:text-[#34d399] border border-emerald-200 dark:border-[#0d4a36]'
                  : statusMessage.type === 'error'
                  ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900/50'
                  : 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-900/50'
              }`}
            >
              {statusMessage.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400" />
              )}
              <span>{statusMessage.text}</span>
            </div>
          )}

          {/* Quick Paste firebaseConfig Snippet Toggle */}
          <div>
            <button
              type="button"
              onClick={() => setShowPasteBox((prev) => !prev)}
              className="w-full py-2 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-[#131b2e] dark:hover:bg-[#1a2540] border border-slate-200 dark:border-[#1e2a45] text-xs font-black text-slate-700 dark:text-slate-200 flex items-center justify-center gap-1.5 transition cursor-pointer"
            >
              <ClipboardPaste className="w-3.5 h-3.5 text-amber-500" />
              <span>{showPasteBox ? 'إخفاء مربع اللصق السريع' : 'لصق كود firebaseConfig دفعة واحدة (اختياري)'}</span>
            </button>

            {showPasteBox && (
              <div className="mt-2 p-3 rounded-2xl bg-slate-50 dark:bg-[#111829] border border-slate-200 dark:border-[#1e2a45] space-y-2">
                <textarea
                  rows={4}
                  dir="ltr"
                  value={rawSnippet}
                  onChange={(e) => setRawSnippet(e.target.value)}
                  placeholder={'const firebaseConfig = {\n  apiKey: "...",\n  projectId: "...",\n  appId: "..."\n};'}
                  className="w-full p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0c1222] text-[11px] font-mono text-slate-900 dark:text-white focus:ring-2 focus:ring-amber-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleApplySnippet}
                  disabled={!rawSnippet.trim()}
                  className="w-full py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs disabled:opacity-50 cursor-pointer"
                >
                  استخراج وتعبئة الحقول تلقائياً ⚡
                </button>
              </div>
            )}
          </div>

          {/* Form */}
          <form onSubmit={handleSave} className="space-y-3.5">
            {/* Project ID */}
            <div>
              <label className="text-xs font-black text-slate-700 dark:text-slate-300 mb-1 flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                <span>معرّف المشروع (Project ID) *</span>
              </label>
              <input
                type="text"
                required
                dir="ltr"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                placeholder="my-firebase-project"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#131b2e] text-slate-900 dark:text-white text-xs font-mono focus:ring-2 focus:ring-amber-500 focus:outline-none"
              />
            </div>

            {/* API Key */}
            <div>
              <label className="text-xs font-black text-slate-700 dark:text-slate-300 mb-1 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                  <span>مفتاح الواجهة (Web API Key) *</span>
                </span>
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="text-[10px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 flex items-center gap-1 cursor-pointer"
                >
                  {showKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  <span>{showKey ? 'إخفاء' : 'إظهار'}</span>
                </button>
              </label>
              <input
                type={showKey ? 'text' : 'password'}
                required
                dir="ltr"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="AIzaSy..."
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#131b2e] text-slate-900 dark:text-white text-xs font-mono focus:ring-2 focus:ring-amber-500 focus:outline-none"
              />
            </div>

            {/* Auth Domain & Firestore Database ID */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-black text-slate-700 dark:text-slate-300 mb-1 flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                  <span>Auth Domain</span>
                </label>
                <input
                  type="text"
                  dir="ltr"
                  value={authDomain}
                  onChange={(e) => setAuthDomain(e.target.value)}
                  placeholder="project.firebaseapp.com"
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#131b2e] text-slate-900 dark:text-white text-xs font-mono focus:ring-2 focus:ring-amber-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-black text-slate-700 dark:text-slate-300 mb-1 flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                  <span>Firestore Database ID</span>
                </label>
                <input
                  type="text"
                  dir="ltr"
                  value={firestoreDatabaseId}
                  onChange={(e) => setFirestoreDatabaseId(e.target.value)}
                  placeholder="(default)"
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#131b2e] text-slate-900 dark:text-white text-xs font-mono focus:ring-2 focus:ring-amber-500 focus:outline-none"
                />
              </div>
            </div>

            {/* App ID & Storage Bucket */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-black text-slate-700 dark:text-slate-300 mb-1">
                  App ID
                </label>
                <input
                  type="text"
                  dir="ltr"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  placeholder="1:...:web:..."
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#131b2e] text-slate-900 dark:text-white text-xs font-mono focus:ring-2 focus:ring-amber-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-black text-slate-700 dark:text-slate-300 mb-1">
                  Storage Bucket
                </label>
                <input
                  type="text"
                  dir="ltr"
                  value={storageBucket}
                  onChange={(e) => setStorageBucket(e.target.value)}
                  placeholder="project.firebasestorage.app"
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#131b2e] text-slate-900 dark:text-white text-xs font-mono focus:ring-2 focus:ring-amber-500 focus:outline-none"
                />
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col sm:flex-row items-center gap-2.5 pt-2">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={isLoading || !projectId || !apiKey}
                className="w-full sm:w-1/2 py-2.5 px-4 bg-slate-100 hover:bg-slate-200 dark:bg-[#152037] dark:hover:bg-[#1e2d4d] text-slate-800 dark:text-slate-200 text-xs font-bold rounded-xl border border-slate-200 dark:border-[#223354] transition flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer active:scale-95"
              >
                {isLoading ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Zap className="w-3.5 h-3.5 text-amber-500" />
                )}
                <span>فحص واختبار الاتصال</span>
              </button>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full sm:w-1/2 py-2.5 px-4 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 active:scale-95 text-slate-950 text-xs font-black rounded-xl shadow-md transition flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
              >
                {isLoading ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                )}
                <span>حفظ الإعدادات والربط 💾</span>
              </button>
            </div>
          </form>

          {/* Quick Guidance Box */}
          <div className="p-3.5 rounded-2xl bg-amber-500/10 dark:bg-amber-950/20 border border-amber-300/40 dark:border-amber-800/30 text-[11px] space-y-1.5">
            <span className="font-black text-amber-900 dark:text-amber-300 block">
              💡 أين تجد هذه البيانات في حساب Firebase؟
            </span>
            <ol className="list-decimal list-inside space-y-1 text-slate-700 dark:text-slate-300 leading-relaxed font-medium">
              <li>ادخل إلى لوحة تحكم <strong>Firebase Console</strong> واختر مشروعك.</li>
              <li>انتقل إلى <strong>Project Settings (أيقونة الترس)</strong> ثم قسم <strong>Your apps</strong>.</li>
              <li>انسخ قيم <strong>firebaseConfig</strong> مثل <code>projectId</code> و<code>apiKey</code> و<code>appId</code>.</li>
              <li>في حال استخدام قاعدة بيانات مخصصة اكتب اسمها في <code>Firestore Database ID</code> أو اتركها <code>(default)</code>.</li>
            </ol>
            <a
              href="https://console.firebase.google.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[10px] font-black text-amber-700 dark:text-amber-400 hover:underline pt-1"
            >
              <span>فتح لوحة تحكم Firebase Console</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};
