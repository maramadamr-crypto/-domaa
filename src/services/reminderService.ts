import { StudyReminder, SubjectId, SUBJECTS, ReminderRepeatType, ReminderPriority } from '../types';
import { ReminderSound } from './reminderSound';
import { generateId } from './fileProcessor';
import { auth, saveReminderToFirestore, deleteReminderFromFirestore } from './firebase';
import { NotificationService } from './notificationService';

const STORAGE_KEY = 'qalami_study_reminders_v1';
const DELETED_REMINDERS_KEY = 'qalami_deleted_reminders_v1';
const NOTIFICATION_PERMISSION_KEY = 'qalami_notification_asked_v1';

function getDeletedReminderIdSet(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(DELETED_REMINDERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id) : []);
  } catch {
    return new Set();
  }
}

function addDeletedReminderIds(ids: string[]): Set<string> {
  const set = getDeletedReminderIdSet();
  let added = false;
  for (const id of ids) {
    if (typeof id === 'string' && id && !set.has(id)) {
      set.add(id);
      added = true;
    }
  }
  if (added && typeof window !== 'undefined') {
    try {
      localStorage.setItem(DELETED_REMINDERS_KEY, JSON.stringify(Array.from(set).slice(-5000)));
    } catch {
      // ignore
    }
  }
  return set;
}

export const ReminderService = {
  /**
   * Get all reminders from localStorage
   */
  getReminders(): StudyReminder[] {
    try {
      const deletedSet = getDeletedReminderIdSet();
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) {
        const initialReminders = this.getInitialReminders().filter((r) => !deletedSet.has(r.id));
        this.saveReminders(initialReminders);
        return initialReminders;
      }
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed.filter((r) => r?.id && !deletedSet.has(r.id)) : [];
    } catch (e) {
      console.error('Failed to load study reminders', e);
      return [];
    }
  },

  /**
   * Save all reminders
   */
  saveReminders(reminders: StudyReminder[]): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(reminders));
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('qalami_reminders_updated'));
      }
    } catch (e) {
      console.error('Failed to save study reminders', e);
    }
  },

  /**
   * Add a new study reminder
   */
  addReminder(params: {
    subjectId: SubjectId;
    customSubjectName?: string;
    title: string;
    targetDate: string; // YYYY-MM-DD
    targetTime: string; // HH:MM
    repeatType?: ReminderRepeatType;
    repeatDays?: number[];
    notes?: string;
    linkedDocId?: string;
    linkedDocTitle?: string;
    priority?: ReminderPriority;
  }): StudyReminder {
    const reminders = this.getReminders();
    const newReminder: StudyReminder = {
      id: `rem_${generateId()}`,
      subjectId: params.subjectId,
      customSubjectName: params.customSubjectName,
      title: params.title.trim() || 'موعد مراجعة المادة',
      targetDate: params.targetDate,
      targetTime: params.targetTime,
      repeatType: params.repeatType || 'once',
      repeatDays: params.repeatDays || [],
      notes: params.notes,
      linkedDocId: params.linkedDocId,
      linkedDocTitle: params.linkedDocTitle,
      priority: params.priority || 'medium',
      isActive: true,
      isCompleted: false,
      createdAt: new Date().toISOString(),
    };

    reminders.unshift(newReminder);
    this.saveReminders(reminders);
    saveReminderToFirestore(newReminder).catch(() => {});
    return newReminder;
  },

  /**
   * Update an existing reminder
   */
  updateReminder(id: string, updates: Partial<StudyReminder>): StudyReminder | null {
    const reminders = this.getReminders();
    const idx = reminders.findIndex((r) => r.id === id);
    if (idx === -1) return null;

    reminders[idx] = {
      ...reminders[idx],
      ...updates,
    };
    this.saveReminders(reminders);
    saveReminderToFirestore(reminders[idx]).catch(() => {});
    return reminders[idx];
  },

  /**
   * Delete reminder
   */
  deleteReminder(id: string): void {
    addDeletedReminderIds([id]);
    const reminders = this.getReminders().filter((r) => r.id !== id);
    this.saveReminders(reminders);
    deleteReminderFromFirestore(id).catch(() => {});
  },

  reconcileDeletedReminders(deletedIds: string[]): void {
    if (!Array.isArray(deletedIds) || deletedIds.length === 0) return;
    const deletedSet = addDeletedReminderIds(deletedIds);
    const current = this.getReminders();
    const filtered = current.filter((r) => !deletedSet.has(r.id));
    if (filtered.length !== current.length) {
      this.saveReminders(filtered);
    }
  },

  /**
   * Toggle active status
   */
  toggleActive(id: string): boolean {
    const reminders = this.getReminders();
    const rem = reminders.find((r) => r.id === id);
    if (!rem) return false;

    rem.isActive = !rem.isActive;
    this.saveReminders(reminders);
    saveReminderToFirestore(rem).catch(() => {});
    return rem.isActive;
  },

  /**
   * Mark as completed
   */
  toggleCompleted(id: string): boolean {
    const reminders = this.getReminders();
    const rem = reminders.find((r) => r.id === id);
    if (!rem) return false;

    rem.isCompleted = !rem.isCompleted;
    if (rem.isCompleted) {
      ReminderSound.playSuccessChime();
    }
    this.saveReminders(reminders);
    saveReminderToFirestore(rem).catch(() => {});
    return rem.isCompleted;
  },

  /**
   * Snooze reminder by X minutes (default 5 mins)
   */
  snoozeReminder(id: string, minutes: number = 5): StudyReminder | null {
    const reminders = this.getReminders();
    const rem = reminders.find((r) => r.id === id);
    if (!rem) return null;

    const now = new Date();
    now.setMinutes(now.getMinutes() + minutes);

    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const mins = String(now.getMinutes()).padStart(2, '0');

    rem.targetDate = `${year}-${month}-${day}`;
    rem.targetTime = `${hours}:${mins}`;
    rem.isCompleted = false;
    rem.isActive = true;
    rem.lastTriggered = undefined; // allow to ring again

    this.saveReminders(reminders);
    saveReminderToFirestore(rem).catch(() => {});
    return rem;
  },

  mergeCloudReminders(cloudReminders: StudyReminder[], removedIds?: string[]): void {
    if (removedIds && removedIds.length > 0) {
      addDeletedReminderIds(removedIds);
    }
    const deletedSet = getDeletedReminderIdSet();
    let local = this.getReminders();
    const filteredLocal = local.filter((r) => !deletedSet.has(r.id));
    let changed = filteredLocal.length !== local.length;
    local = filteredLocal;

    if (Array.isArray(cloudReminders) && cloudReminders.length > 0) {
      for (const remote of cloudReminders) {
        if (!remote?.id || deletedSet.has(remote.id)) continue;
        const idx = local.findIndex((r) => r.id === remote.id);
        if (idx >= 0) {
          const cur = local[idx];
          if (
            cur.isCompleted !== remote.isCompleted ||
            cur.isActive !== remote.isActive ||
            cur.targetDate !== remote.targetDate ||
            cur.targetTime !== remote.targetTime ||
            cur.title !== remote.title
          ) {
            local[idx] = { ...cur, ...remote };
            changed = true;
          }
        } else {
          local.unshift(remote);
          changed = true;
        }
      }
    }

    if (changed) {
      this.saveReminders(local);
    }
  },

  syncLocalRemindersToFirestore(): void {
    if (!auth.currentUser) return;
    const deletedSet = getDeletedReminderIdSet();
    const reminders = this.getReminders();
    for (const r of reminders) {
      if (!r?.id || deletedSet.has(r.id)) continue;
      saveReminderToFirestore(r).catch(() => {});
    }
  },

  /**
   * Check if any reminder is due right now.
   * Compares current date and HH:MM to active reminders.
   */
  checkDueReminders(): StudyReminder[] {
    const reminders = this.getReminders();
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
    const currentDay = String(now.getDate()).padStart(2, '0');
    const currentDateStr = `${currentYear}-${currentMonth}-${currentDay}`;

    const currentHours = String(now.getHours()).padStart(2, '0');
    const currentMinutes = String(now.getMinutes()).padStart(2, '0');
    const currentTimeStr = `${currentHours}:${currentMinutes}`;
    const currentDayOfWeek = now.getDay(); // 0 is Sunday, 5 is Friday, etc.

    const dueList: StudyReminder[] = [];

    for (const rem of reminders) {
      if (!rem.isActive || rem.isCompleted) continue;

      let isDueTime = false;

      // Handle repetition vs one-off
      if (rem.repeatType === 'once') {
        if (rem.targetDate === currentDateStr && rem.targetTime === currentTimeStr) {
          isDueTime = true;
        }
      } else if (rem.repeatType === 'daily') {
        if (rem.targetTime === currentTimeStr) {
          isDueTime = true;
        }
      } else if (rem.repeatType === 'weekdays') {
        // In Egypt/Arab world school week: Sunday (0) to Thursday (4)
        const isSchoolDay = currentDayOfWeek >= 0 && currentDayOfWeek <= 4;
        if (isSchoolDay && rem.targetTime === currentTimeStr) {
          isDueTime = true;
        }
      } else if (rem.repeatType === 'custom' && rem.repeatDays) {
        if (rem.repeatDays.includes(currentDayOfWeek) && rem.targetTime === currentTimeStr) {
          isDueTime = true;
        }
      }

      if (isDueTime) {
        // Prevent re-triggering multiple times within the same minute
        const triggerKey = `${currentDateStr}_${currentTimeStr}`;
        if (rem.lastTriggered !== triggerKey) {
          rem.lastTriggered = triggerKey;
          dueList.push(rem);
        }
      }
    }

    if (dueList.length > 0) {
      this.saveReminders(reminders);
    }

    return dueList;
  },

  /**
   * Fire notification and play alert sound
   */
  triggerNotification(reminder: StudyReminder): void {
    // 1. Play synthesized bell/alert sound
    if (reminder.priority === 'high') {
      ReminderSound.playUrgentAlert();
    } else {
      ReminderSound.playStudyChime();
    }

    // 2. Trigger browser notification if supported and granted
    const subject = SUBJECTS.find((s) => s.id === reminder.subjectId);
    const subjectName = reminder.customSubjectName || subject?.nameAr || 'المادة الدراسية';

    // 3. Save to notification center history
    try {
      NotificationService.addNotification({
        title: `🔔 حان موعد مراجعة: ${subjectName}`,
        body: `${reminder.title} - ابدأ المذاكرة الآن واستعن بقلمك والمعلم الذكي!`,
        type: 'reminder',
        subjectName,
      });
    } catch {
      // ignore
    }
  },

  /**
   * Request browser notifications permission
   */
  async requestNotificationPermission(): Promise<NotificationPermission> {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return 'denied';
    }
    try {
      const perm = await Notification.requestPermission();
      localStorage.setItem(NOTIFICATION_PERMISSION_KEY, perm);
      return perm;
    } catch (e) {
      console.warn('Error requesting notification permission', e);
      return 'denied';
    }
  },

  getNotificationPermissionStatus(): NotificationPermission | 'unsupported' {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return 'unsupported';
    }
    return Notification.permission;
  },

  /**
   * Friendly starter schedule for 5th grade students
   */
  getInitialReminders(): StudyReminder[] {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const todayStr = `${y}-${m}-${d}`;

    // Target a couple of realistic study times (e.g. 17:00 / 5 PM and 19:30 / 7:30 PM)
    return [
      {
        id: 'init_rem_arabic',
        subjectId: 'arabic',
        title: 'مراجعة درس القراءة وقواعد النحو (اللغة العربية)',
        targetDate: todayStr,
        targetTime: '17:00',
        repeatType: 'daily',
        notes: 'مراجعة علامات الإعراب وحل نموذج تدريبات كتاب الامتحان',
        priority: 'high',
        isActive: true,
        isCompleted: false,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'init_rem_math',
        subjectId: 'math',
        title: 'حل مسائل ضرب وقسمة الكسور العشرية (الرياضيات)',
        targetDate: todayStr,
        targetTime: '18:30',
        repeatType: 'daily',
        notes: 'حل 5 مسائل متنوعة من كتاب سلاح التلميذ',
        priority: 'medium',
        isActive: true,
        isCompleted: false,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'init_rem_science',
        subjectId: 'science',
        title: 'مراجعة المفهوم الأول: التكيف والبقاء (العلوم)',
        targetDate: todayStr,
        targetTime: '20:00',
        repeatType: 'weekdays',
        notes: 'مذاكرة المصطلحات العلمية في أجهزة الكائنات الحية',
        priority: 'normal',
        isActive: true,
        isCompleted: false,
        createdAt: new Date().toISOString(),
      },
    ];
  },
};
