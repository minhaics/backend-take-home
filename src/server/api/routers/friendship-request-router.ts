import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { FriendshipStatusSchema } from '@/utils/server/friendship-schemas';
import { authGuard } from '@/server/trpc/middlewares/auth-guard';
import { procedure } from '@/server/trpc/procedures';
import { IdSchema } from '@/utils/server/base-schemas';
import { router } from '@/server/trpc/router';

// Định nghĩa type cho một yêu cầu kết bạn (Friendship)
interface Friendship {
  id: number; // ID của yêu cầu kết bạn
  userId: number; // ID của người gửi yêu cầu kết bạn
  friendUserId: number; // ID của người nhận yêu cầu kết bạn
  status: 'requested' | 'accepted' | 'declined'; // Trạng thái của yêu cầu kết bạn
}

// Schema cho đầu vào của các yêu cầu kết bạn
const SendFriendshipRequestInputSchema = z.object({
  friendUserId: IdSchema, // Xác định ID của người nhận yêu cầu kết bạn
});

// Schema cho đầu vào của việc chấp nhận hoặc từ chối yêu cầu kết bạn
const AnswerFriendshipRequestInputSchema = z.object({
  friendUserId: IdSchema, // Xác định ID của người gửi yêu cầu kết bạn
});

// Middleware kiểm tra điều kiện trước khi gửi yêu cầu kết bạn
const canSendFriendshipRequest = authGuard.unstable_pipe(
  async ({ ctx, rawInput, next }) => {
    const { friendUserId } = SendFriendshipRequestInputSchema.parse(rawInput); // Xác thực đầu vào

    // Kiểm tra xem người nhận yêu cầu kết bạn có tồn tại không
    await ctx.db
      .selectFrom('users')
      .where('users.id', '=', friendUserId)
      .select('id')
      .limit(1)
      .executeTakeFirstOrThrow(() => new TRPCError({ code: 'BAD_REQUEST' }));

    return next({ ctx }); // Tiếp tục thực hiện nếu không có lỗi
  }
);

// Middleware kiểm tra điều kiện trước khi chấp nhận yêu cầu kết bạn
const canAnswerFriendshipRequest = authGuard.unstable_pipe(
  async ({ ctx, rawInput, next }) => {
    const { friendUserId } = AnswerFriendshipRequestInputSchema.parse(rawInput); // Xác thực đầu vào

    // Kiểm tra xem yêu cầu kết bạn với trạng thái 'requested' có tồn tại không
    await ctx.db
      .selectFrom('friendships')
      .where('friendships.userId', '=', friendUserId)
      .where('friendships.friendUserId', '=', ctx.session.userId)
      .where('friendships.status', '=', FriendshipStatusSchema.Values['requested'])
      .select('friendships.id')
      .limit(1)
      .executeTakeFirstOrThrow(() => {
        throw new TRPCError({ code: 'BAD_REQUEST' });
      });

    return next({ ctx }); // Tiếp tục thực hiện nếu không có lỗi
  }
);

// Hàm kiểm tra và cập nhật yêu cầu kết bạn nếu có
async function checkAndUpdateFriendshipRequest(ctx: any, userId: number, friendUserId: number) {
  // Kiểm tra xem yêu cầu kết bạn đã tồn tại chưa
  const existingFriendship = await ctx.db
    .selectFrom('friendships')
    .where('userId', '=', userId)
    .where('friendUserId', '=', friendUserId)
    .select(['status'])
    .executeTakeFirst() as Pick<Friendship, 'status'> | undefined;

  if (existingFriendship) {
    if (existingFriendship.status === 'declined') {
      // Nếu yêu cầu kết bạn đã bị từ chối trước đó, cập nhật lại thành 'requested'
      await ctx.db
        .updateTable('friendships')
        .set({ status: 'requested' })
        .where('userId', '=', userId)
        .where('friendUserId', '=', friendUserId)
        .execute();
    } else {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Yêu cầu kết bạn đã tồn tại hoặc đã được chấp nhận.',
      });
    }
  } else {
    // Nếu không có yêu cầu kết bạn nào trước đó, tạo mới một yêu cầu kết bạn
    await ctx.db
      .insertInto('friendships')
      .values({
        userId,
        friendUserId,
        status: 'requested',
      })
      .execute();
  }
}

// Hàm chấp nhận yêu cầu kết bạn và cập nhật trạng thái
async function acceptFriendshipRequest(
  t: any,
  userId: number,
  friendUserId: number
): Promise<void> {
  // Cập nhật yêu cầu kết bạn của người bạn (người được gửi) thành 'accepted'
  await t
    .updateTable('friendships')
    .set({ status: 'accepted' })
    .where('userId', '=', friendUserId)
    .where('friendUserId', '=', userId)
    .execute();

  // Kiểm tra nếu người dùng cũng đã gửi yêu cầu kết bạn trước đó
  const existingFriendship = await t
    .selectFrom('friendships')
    .where('userId', '=', userId)
    .where('friendUserId', '=', friendUserId)
    .select(['id'])
    .executeTakeFirst();

  if (existingFriendship) {
    // Nếu có, cập nhật trạng thái thành 'accepted'
    await t
      .updateTable('friendships')
      .set({ status: 'accepted' })
      .where('userId', '=', userId)
      .where('friendUserId', '=', friendUserId)
      .execute();
  } else {
    // Nếu không, tạo mới bản ghi với trạng thái 'accepted'
    await t
      .insertInto('friendships')
      .values({
        userId,
        friendUserId,
        status: 'accepted',
      })
      .execute();
  }
}

// Định nghĩa router cho các yêu cầu kết bạn
export const friendshipRequestRouter = router({
  // Xử lý việc gửi yêu cầu kết bạn
  send: procedure
    .use(canSendFriendshipRequest) // Sử dụng middleware để kiểm tra trước khi gửi
    .input(SendFriendshipRequestInputSchema) // Xác thực đầu vào
    .mutation(async ({ ctx, input }) => {
      /**
       * Question 3: Fix bug
       *
       * Fix a bug where our users could not send a friendship request after
       * they'd previously been declined. Steps to reproduce:
       *  1. User A sends a friendship request to User B
       *  2. User B declines the friendship request
       *  3. User A tries to send another friendship request to User B -> ERROR
       *
       */
      // Kiểm tra và cập nhật yêu cầu kết bạn nếu cần
      await checkAndUpdateFriendshipRequest(ctx, ctx.session.userId, input.friendUserId);
    }),

  // Xử lý việc chấp nhận yêu cầu kết bạn
  accept: procedure
    .use(canAnswerFriendshipRequest) // Sử dụng middleware để kiểm tra trước khi chấp nhận
    .input(AnswerFriendshipRequestInputSchema) // Xác thực đầu vào
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction().execute(async (t) => {
        /**
         * Question 1: Implement api to accept a friendship request
         *
         * When a user accepts a friendship request, we need to:
         *  1. Update the friendship request to have status `accepted`
         *  2. Create a new friendship request record with the opposite user as the friend
         *
         * The end result that we want will look something like this
         *
         *  | userId | friendUserId | status   |
         *  | ------ | ------------ | -------- |
         *  | 1      | 2            | accepted |
         *  | 2      | 1            | accepted |
         *
         * Documentation references:
         *  - https://kysely-org.github.io/kysely/classes/Transaction.html#transaction
         *  - https://kysely-org.github.io/kysely/classes/Kysely.html#insertInto
         *  - https://kysely-org.github.io/kysely/classes/Kysely.html#updateTable
         */
        await acceptFriendshipRequest(t, ctx.session.userId, input.friendUserId);
      });
    }),

  // Xử lý việc từ chối yêu cầu kết bạn
  decline: procedure
    .use(canAnswerFriendshipRequest) // Sử dụng middleware để kiểm tra trước khi từ chối
    .input(AnswerFriendshipRequestInputSchema) // Xác thực đầu vào
    .mutation(async ({ ctx, input }) => {
      /**
       * Question 2: Implement api to decline a friendship request
       *
       * Set the friendship request status to `declined`
       *
       * Documentation references:
       *  - https://vitest.dev/api/#test-skip
       */
      return ctx.db
        .updateTable('friendships')
        .set({ status: 'declined' })
        .where('userId', '=', input.friendUserId)
        .where('friendUserId', '=', ctx.session.userId)
        .execute();
    }),
});
