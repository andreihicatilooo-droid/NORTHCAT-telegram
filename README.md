# CRB GA — Telegram Mini App (гарант сделок)

Гарант-сервис (эскроу) для безопасных сделок в Telegram. Приём оплаты:
**xRocket**, **Bitpapa**, **PGon**, **NicePay**, **RuKassa**.
Вход: автоматически внутри Telegram (Mini App) или через Telegram Login Widget в браузере.

Средства покупателя замораживаются у гаранта и выплачиваются продавцу только
после подтверждения приёмки. При конфликте открывается спор, который разбирает
арбитр.

## Из чего состоит

| Часть | Путь | Описание |
|---|---|---|
| Mini App (фронтенд) | `index.html`, `css/`, `js/` | Статическая страница без сборки: список сделок, создание, статусы, оплата |
| Бэкенд | `backend/` | Node.js + Express: сделки, счета xRocket Pay, webhook об оплате, заявки Bitpapa |

## Флоу сделки

1. **Создана** — стороны договорились, создана сделка с условиями и суммой.
2. **Оплачена** — покупатель заплатил (xRocket-счёт или перевод Bitpapa с кодом сделки), средства у гаранта.
3. **Выполнена** — продавец передал товар / выполнил условия.
4. **Завершена** — покупатель подтвердил приёмку, гарант выплачивает продавцу сумму за вычетом комиссии.
5. **Спор** — на шагах 2–3 любая сторона может открыть спор, его решает арбитр.

## Быстрый старт (демо-режим)

Фронтенд работает без бэкенда: сделки хранятся в localStorage, оплата
симулируется, есть кнопки «Демо: …» для прохода всего флоу.

1. Опубликуйте корень репозитория на GitHub Pages (Settings → Pages → Deploy from branch).
2. В [@BotFather](https://t.me/BotFather): `/newbot`, затем `/setmenubutton` (или Bot Settings → Menu Button) и укажите URL страницы.
3. Откройте бота → кнопка меню → Mini App запустится.

## Боевой режим (с бэкендом)

### 1. Настройте бэкенд

```bash
cd backend
npm install
cp .env.example .env   # заполните значения
node server.js
```

Переменные окружения (`backend/.env.example`):

- `BOT_TOKEN` — токен бота из @BotFather (проверка подписи `initData` и Login Widget, без неё запросы отклоняются);
- `ADMIN_IDS` — Telegram ID гарантов/арбитров через запятую;
- `XROCKET_API_KEY` — ключ Rocket Pay: бот [@xRocket](https://t.me/xrocket) → **Rocket Pay → Create App → API Key**. Там же укажите webhook: `https://ваш-домен/webhook/xrocket`;
- `PGON_API_URL`, `PGON_API_KEY` — доступы шлюза PGon (поля запроса сверьте с документацией в `createPgonInvoice`);
- `NICEPAY_MERCHANT_ID`, `NICEPAY_SECRET` — доступы [NicePay](https://nicepay.io);
- `RUKASSA_SHOP_ID`, `RUKASSA_TOKEN` — доступы [RuKassa](https://lk.rukassa.pro);
- `WEBHOOK_SECRET` — секрет вебхуков шлюзов: добавьте его в URL вебхука в кабинете шлюза (`/webhook/rukassa?secret=...`);
- `BITPAPA_API_TOKEN` — токен API [Bitpapa](https://bitpapa.com) для автопроверки входящих переводов (пока переводы подтверждает гарант вручную через `POST /api/deals/:id/mark-paid`);
- `PUBLIC_URL` — публичный адрес бэкенда.

Тестовая среда xRocket: `XROCKET_API_URL=https://dev-pay.xrocket.tg` (бот @xrocket_dev_bot).

### 2. Подключите фронтенд к бэкенду

В `js/config.js`:

- `API_URL` — `"auto"`, если бэкенд отдаёт фронтенд сам (проверяется `/api/health`, при недоступности — демо-режим); `""` — принудительное демо; иначе полный адрес бэкенда;
- `BOT_USERNAME` — username бота для Telegram Login Widget (вход из браузера). Привяжите домен к боту: @BotFather → `/setdomain`;
- при необходимости — `FEE_PERCENT`, `SUPPORT_USERNAME`, `BITPAPA_ACCOUNT`, список `PAY_METHODS`.

### 3. Как проходит оплата

- **xRocket** — бэкенд создаёт счёт (`POST /tg-invoices` xRocket Pay API), Mini App открывает ссылку счёта, после оплаты xRocket шлёт webhook и сделка автоматически переходит в «Оплачена».
- **PGon / NicePay / RuKassa** — бэкенд создаёт платёж в шлюзе и возвращает ссылку на страницу оплаты; после оплаты шлюз шлёт webhook (`/webhook/pgon|nicepay|rukassa?secret=...`), сделка помечается оплаченной (сумма сверяется).
- **Bitpapa** — покупателю показываются реквизиты и код сделки для комментария к переводу; гарант сверяет поступление (вручную или через API Bitpapa в `verifyBitpapaTransfer`) и отмечает сделку оплаченной.

### 4. Выплата продавцу

Когда покупатель подтверждает приёмку, сделка становится «Завершена» — в этом месте
(`backend/server.js`, обработчик статуса `completed`) подключите выплату продавцу,
например переводом через xRocket (`POST /app/transfer`).

## API бэкенда

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/health` | Проверка доступности бэкенда |
| POST | `/api/auth/telegram` | Вход через Login Widget → токен сессии |
| GET | `/api/deals` | Сделки текущего пользователя |
| POST | `/api/deals` | Создать сделку |
| POST | `/api/deals/:id/status` | Сменить статус (переходы валидируются) |
| POST | `/api/deals/:id/invoice` | Создать счёт (xRocket / PGon / NicePay / RuKassa), вернуть ссылку |
| POST | `/api/deals/:id/bitpapa-claim` | Покупатель сообщил о переводе Bitpapa |
| POST | `/api/deals/:id/mark-paid` | Гарант подтвердил оплату (только `ADMIN_IDS`) |
| POST | `/webhook/xrocket` | Webhook xRocket об оплате счёта (проверка подписи) |
| POST | `/webhook/pgon` · `/webhook/nicepay` · `/webhook/rukassa` | Вебхуки шлюзов (`?secret=WEBHOOK_SECRET`, сверка суммы) |

## Telegram-бот (команды)

| Команда | Описание |
|---|---|
| `/start`, `/app` | Открыть Mini App, установить кнопку меню |
| `/deal <ID>` | Проверить состояние сделки по ID |
| `/support` | Задать вопрос — следующее сообщение пересылается гарантам |
| `/admin` | Сводка для ID из `ADMIN_IDS` |

Бот работает в режиме long-polling и не требует публичного URL.  
Когда пользователь впервые обращается к боту, его `chat_id` сохраняется в `backend/user_chats.json`.
Это позволяет доставлять уведомления обеим сторонам сделки при изменении статуса.

Защищённые `/api/*`-запросы требуют заголовок `X-Telegram-Init-Data` (Mini App) или `X-Auth-Token` (после входа через Login Widget).

## Важно

- В `backend/deals.json` — простое файловое хранилище для старта; для продакшена перенесите на БД (PostgreSQL/SQLite).
- Комиссия и сумма к оплате всегда пересчитываются на сервере — клиенту не доверяем.
- Убедитесь, что деятельность гаранта соответствует законодательству вашей юрисдикции и правилам платёжных сервисов.
