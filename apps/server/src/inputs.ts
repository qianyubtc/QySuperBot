import { z } from 'zod';
import { binanceGroupId } from './binance.ts';
const id = z.string().min(1).max(256);
export const credentialsInput = z.strictObject({
  username: z.string().trim().min(2).max(64),
  password: z.string().min(1).max(256),
});
export const setupInput = credentialsInput.extend({
  password: z.string().min(10).max(256),
  setup_token: z.string().max(256).optional(),
});
export const policyInput = z.strictObject({
  mode: z.enum(['observe', 'enforce']),
  keywords: z.array(z.string().trim().min(1).max(128)).max(100),
  blocked_domains: z.array(z.string().trim().min(1).max(253)).max(100),
  action: z.enum(['delete', 'remove', 'ban']),
  verification_enabled: z.boolean(),
  verification_timeout: z.number().int().min(30).max(3600),
  verification_timeout_action: z.enum(['manual', 'remove', 'mute_retry']).optional(),
  verification_failed_action: z.enum(['manual', 'mute']).optional(),
});
export type Policy = z.infer<typeof policyInput>;
export const defaultPolicy: Policy = {
  mode: 'observe',
  keywords: [],
  blocked_domains: [],
  action: 'delete',
  verification_enabled: false,
  verification_timeout: 120,
};
export const accountInput = z
  .strictObject({
    kind: z.enum(['custom', 'telegram', 'qq', 'binance']),
    name: z.string().trim().min(1).max(100),
    endpoint: z.url({ protocol: /^https?$/ }).optional(),
    token: z.string().min(1).max(2048).optional(),
    group_ids: z.array(binanceGroupId).max(20).optional(),
  })
  .refine(
    (value) =>
      value.kind === 'binance' ? true : value.kind === 'telegram' ? !!value.token : !!value.endpoint,
    {
      message: '请填写连接地址或机器人 Token',
    },
  );
export const announcementInput = z
  .strictObject({
    title: z.string().trim().min(1).max(120),
    content: z.string().trim().max(8000).default(''),
    image_asset_id: z
      .string()
      .regex(/^upload-image-[a-f0-9]{64}$/)
      .optional(),
    conversation_ids: z.array(id).min(1).max(100),
    scheduled_at: z.iso.datetime().optional(),
  })
  .refine((value) => value.content.length || value.image_asset_id, { message: '请填写文字或上传图片' });
export const sendInput = z.strictObject({
  conversation_ids: z.array(id).min(1).max(100),
  text: z.string().trim().min(1).max(8000),
  reply_to_message_id: id.optional(),
});
export const projectInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  conversation_ids: z.array(id).min(1).max(100),
  scopes: z
    .array(z.enum(['conversations.read', 'messages.send', 'deliveries.read', 'lotteries.write']))
    .min(1),
});
export const blacklistInput = z.strictObject({
  conversation_id: id,
  user_id: id,
  reason: z.string().trim().min(1).max(500),
  expires_at: z.iso.datetime().nullable().optional(),
});
export const routeInput = z
  .strictObject({ source_id: id, target_id: id, enabled: z.boolean().default(true) })
  .refine((value) => value.source_id !== value.target_id, { message: '来源群和目标群不能相同' });
export const lotteryInput = z.strictObject({
  conversation_id: id,
  title: z.string().trim().min(1).max(120),
  winners_count: z.number().int().min(1).max(100),
  closes_at: z.iso.datetime(),
});
