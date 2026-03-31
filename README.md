# Israeli Bank Scraper Server

שרת Node.js חיצוני לגרידת נתונים מבנקים ישראליים באמצעות [israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers).

## התקנה מהירה

```bash
npm install
cp .env.example .env
# ערוך את .env והגדר API_KEY
npm start
```

## Deploy ל-Railway

1. צור פרויקט חדש ב-[Railway](https://railway.app)
2. חבר את ה-repo או העלה את הקבצים
3. הגדר environment variable: `API_KEY=your-secret-key`
4. Railway יזהה את ה-Dockerfile אוטומטית

## Deploy ל-Render

1. צור Web Service חדש ב-[Render](https://render.com)
2. בחר Docker כ-runtime
3. הגדר environment variable: `API_KEY=your-secret-key`

## שימוש

### Health Check
```
GET /health
```

### Scrape
```
POST /scrape
Headers:
  X-API-Key: your-api-key
  Content-Type: application/json

Body:
{
  "bank_type": "hapoalim",
  "credentials": {
    "userCode": "...",
    "password": "..."
  },
  "connection_id": "uuid",
  "organization_id": "uuid"
}
```

### סוגי Credentials לפי בנק

| בנק | שדות נדרשים |
|-----|-------------|
| הפועלים | `userCode`, `password` |
| לאומי | `username`, `password` |
| דיסקונט | `id`, `password`, `num` |
| מזרחי | `id`, `password` |
| כאל | `username`, `password` |
| מקס | `username`, `password` |
| ישראכרט | `id`, `card6Digits`, `password` |
| אמריקן אקספרס | `id`, `card6Digits`, `password` |

## חיבור ל-Lovable

אחרי ה-deploy, הגדר ב-Lovable:
1. **SCRAPER_SERVER_URL** = כתובת השרת (למשל `https://your-app.railway.app`)
2. **SCRAPER_API_KEY** = אותו API_KEY שהגדרת בשרת
