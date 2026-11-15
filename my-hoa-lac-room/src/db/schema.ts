import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Custom INET type for PostgreSQL (supports IPv4/IPv6 addresses)
 */
const inet = customType<{ data: string }>({
  dataType() {
    return 'inet';
  },
});

// ==========================================================
// ENUMS (matching SQL CHECK constraints)
// ==========================================================
export const userRoleEnum = pgEnum('user_role', ['admin', 'ctv']);
export const roomStatusEnum = pgEnum('room_status', ['available', 'rented']);
export const spamBlocklistKindEnum = pgEnum('spam_blocklist_kind', ['phone', 'ip']);
export const appointmentStatusEnum = pgEnum('appointment_status', [
  'pending',
  'contacted',
  'viewed',
  'completed',
  'cancelled',
]);
export const commissionStatusEnum = pgEnum('commission_status', ['pending', 'paid']);

// ==========================================================
// 1. USERS (Admin + CTV)
// ==========================================================
export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    fullName: varchar('full_name', { length: 100 }).notNull(),
    avatarUrl: text('avatar_url'),
    phone: varchar('phone', { length: 20 }),
    role: varchar('role', { length: 20 }).notNull().$type<'admin' | 'ctv'>(),
    isActive: boolean('is_active').notNull().default(true),
    bannedReason: text('banned_reason'),
    bannedAt: timestamp('banned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_users_active_ctv')
      .on(table.id)
      .where(sql`${table.role} = 'ctv' AND ${table.isActive} = true`),
  ]
);

// ==========================================================
// 2. ROOMS
// ==========================================================
export const rooms = pgTable(
  'rooms',
  {
    id: serial('id').primaryKey(),
    slug: varchar('slug', { length: 255 }).notNull().unique(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    location: varchar('location', { length: 100 }).notNull(),
    price: integer('price').notNull(), // Lưu VNĐ (lớn hơn 0)
    area: numeric('area', { precision: 5, scale: 2 }).notNull(), // m2
    utilities: jsonb('utilities').$type<string[]>().default([]),
    status: varchar('status', { length: 20 })
      .notNull()
      .default('available')
      .$type<'available' | 'rented'>(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_rooms_available')
      .on(table.location, table.price)
      .where(sql`${table.status} = 'available' AND ${table.deletedAt} IS NULL`),
    index('idx_rooms_utilities').using('gin', table.utilities),
  ]
);

// ==========================================================
// 3. ROOM_IMAGES (Cloudflare R2)
// ==========================================================
export const roomImages = pgTable(
  'room_images',
  {
    id: serial('id').primaryKey(),
    roomId: integer('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    r2Key: text('r2_key').notNull(),
    altText: varchar('alt_text', { length: 255 }),
    sortOrder: smallint('sort_order').notNull().default(0),
    isCover: boolean('is_cover').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_room_images_room').on(table.roomId, table.sortOrder),
    uniqueIndex('uq_room_images_cover')
      .on(table.roomId)
      .where(sql`${table.isCover} = true`),
  ]
);

// ==========================================================
// 4. SPAM_BLOCKLIST (Chặn SĐT / IP thủ công)
// ==========================================================
export const spamBlocklist = pgTable(
  'spam_blocklist',
  {
    id: serial('id').primaryKey(),
    kind: varchar('kind', { length: 10 }).notNull().$type<'phone' | 'ip'>(),
    value: text('value').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_spam_blocklist_kind_value').on(table.kind, table.value),
  ]
);

// ==========================================================
// 5. APPOINTMENTS (Lịch hẹn + Chống spam)
// ==========================================================
export const appointments = pgTable(
  'appointments',
  {
    id: serial('id').primaryKey(),
    roomId: integer('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'restrict' }),
    refCtvId: integer('ref_ctv_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    guestName: varchar('guest_name', { length: 100 }).notNull(),
    guestPhone: varchar('guest_phone', { length: 20 }).notNull(),
    appointmentTime: timestamp('appointment_time', {
      withTimezone: true,
    }).notNull(),
    note: text('note'),
    status: varchar('status', { length: 20 })
      .notNull()
      .default('pending')
      .$type<'pending' | 'contacted' | 'viewed' | 'completed' | 'cancelled'>(),

    // Trạng thái gửi email thông báo
    emailSent: boolean('email_sent').notNull().default(false),
    emailAttempts: smallint('email_attempts').notNull().default(0),
    emailError: text('email_error'),

    // Dữ liệu chống spam (IP / User Agent)
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_appointments_room').on(table.roomId),
    index('idx_appointments_status').on(table.status),
    index('idx_appointments_created').on(table.createdAt.desc()),
    index('idx_appointments_phone').on(table.guestPhone, table.createdAt.desc()),
    index('idx_appointments_ip').on(table.ipAddress, table.createdAt.desc()),
    index('idx_appointments_ref_ctv')
      .on(table.refCtvId)
      .where(sql`${table.refCtvId} IS NOT NULL`),
  ]
);

// ==========================================================
// 6. COMMISSIONS (Hoa hồng CTV)
// ==========================================================
export const commissions = pgTable(
  'commissions',
  {
    id: serial('id').primaryKey(),
    roomId: integer('room_id').references(() => rooms.id, {
      onDelete: 'set null',
    }),
    ctvId: integer('ctv_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    appointmentId: integer('appointment_id')
      .unique()
      .references(() => appointments.id, { onDelete: 'set null' }),
    guestName: varchar('guest_name', { length: 100 }).notNull(),
    commissionAmount: integer('commission_amount').notNull(),
    status: varchar('status', { length: 20 })
      .notNull()
      .default('pending')
      .$type<'pending' | 'paid'>(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_commissions_ctv').on(table.ctvId),
    index('idx_commissions_room').on(table.roomId),
  ]
);

// ==========================================================
// RELATIONS (Drizzle ORM Relational Queries)
// ==========================================================
export const usersRelations = relations(users, ({ many }) => ({
  appointments: many(appointments),
  commissions: many(commissions),
}));

export const roomsRelations = relations(rooms, ({ many }) => ({
  images: many(roomImages),
  appointments: many(appointments),
  commissions: many(commissions),
}));

export const roomImagesRelations = relations(roomImages, ({ one }) => ({
  room: one(rooms, {
    fields: [roomImages.roomId],
    references: [rooms.id],
  }),
}));

export const appointmentsRelations = relations(appointments, ({ one }) => ({
  room: one(rooms, {
    fields: [appointments.roomId],
    references: [rooms.id],
  }),
  refCtv: one(users, {
    fields: [appointments.refCtvId],
    references: [users.id],
  }),
  commission: one(commissions, {
    fields: [appointments.id],
    references: [commissions.appointmentId],
  }),
}));

export const commissionsRelations = relations(commissions, ({ one }) => ({
  room: one(rooms, {
    fields: [commissions.roomId],
    references: [rooms.id],
  }),
  ctv: one(users, {
    fields: [commissions.ctvId],
    references: [users.id],
  }),
  appointment: one(appointments, {
    fields: [commissions.appointmentId],
    references: [appointments.id],
  }),
}));

// ==========================================================
// TYPE INFERENCES (Tối ưu TypeScript DX)
// ==========================================================
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;

export type RoomImage = typeof roomImages.$inferSelect;
export type NewRoomImage = typeof roomImages.$inferInsert;

export type SpamBlocklist = typeof spamBlocklist.$inferSelect;
export type NewSpamBlocklist = typeof spamBlocklist.$inferInsert;

export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;

export type Commission = typeof commissions.$inferSelect;
export type NewCommission = typeof commissions.$inferInsert;

