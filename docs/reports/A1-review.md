# A1 · ביקורת חוזרת (Opus reviewer, 11.10.2026)

**APPROVE**: ארבעת הסעיפים מהביקורת הקודמת תוקנו ואומתו בהרצה.
- **החבילה המלאה:** ‏`run.ts` עבר, כולל הרצת המיגרציות פעמיים, `RLS_TESTS_PASSED (152 checks)`, ‏rollback נקי ו-10/10 מוטציות. ‏`sql_lint.py` עבר (16 טבלאות public ו-5 private).
- **בדיקות בעותק זמני (נמחק):** אחרי `run_retention()` נשארו `quote_drafts=0` ו-`admin_notes=0` על כל הישויות (client, quote, questionnaire, tenant, request, lead). השדות `scope_md` ו-`timeline_text` ריקים (null) ו-`assumptions=[]`. ה-token הוחלף ונקבע `anonymized=true`.
- **כשל של לקוח אחד:** הכשלתי בכוונה את האנונימיזציה של לקוח אחד. ניקוי 90 הימים בכל זאת רץ (ה-SMS נמחקו ו-`from_e164` אופס ל-null). נרשם אירוע `retention_error`, והלקוח שנכשל נשאר בלי אנונימיזציה, כך שינוסה שוב בריצה הבאה.
- **פונקציות credentials:** ‏`runtime_get_credential` ו-`runtime_put_credential` נחסמות ללקוח מחובר ול-anon. ל-service role הן עובדות (כתיבה וקריאה חזרה).
- **לשים לב:** ב-A6, ‏quote-view ו-quote-accept חייבים לסרב להצעה שמסומנת `anonymized`. ב-A2 צריך לאמת ש-`delete from auth.users` עובד מתוך cron ב-Supabase אמיתי.
