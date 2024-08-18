import type { Database } from '@/server/db'

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { FriendshipStatusSchema } from '@/utils/server/friendship-schemas'
import { protectedProcedure } from '@/server/trpc/procedures'
import { router } from '@/server/trpc/router'
import {
  NonEmptyStringSchema,
  CountSchema,
  IdSchema,
} from '@/utils/server/base-schemas'


//  implement myself

//Định nghĩa schema với zod
const friendInfoSchema = z.object({
  id: IdSchema,
  fullName: NonEmptyStringSchema,
  phoneNumber: NonEmptyStringSchema,
  totalFriendCount: CountSchema,
  mutualFriendCount: CountSchema,
});

export const myFriendRouter = router({
  getById: protectedProcedure
    .input(
      z.object({
        friendUserId: IdSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Truy vấn riêng biệt để tính mutualFriendCount
      const mutualFriendCountResult = await ctx.db
        .selectFrom('friendships as f1')
        .innerJoin('friendships as f2', 'f1.friendUserId', 'f2.friendUserId')
        .where('f1.userId', '=', ctx.session.userId)  // Alice's userId
        .where('f2.userId', '=', input.friendUserId)  // Bob's userId
        .where('f1.status', '=', FriendshipStatusSchema.Values['accepted'])
        .where('f2.status', '=', FriendshipStatusSchema.Values['accepted'])
        // .select(ctx.db.fn.count('f1.friendUserId').as('mutualFriendCount'))
        .select((eb) =>
          eb.fn.count('f1.friendUserId').as('mutualFriendCount')
        )
        .executeTakeFirstOrThrow();

      // Truy vấn chính để lấy thông tin bạn bè
      const friendInfo = await ctx.db
        .selectFrom('users as friends')
        .innerJoin('friendships', 'friendships.friendUserId', 'friends.id')
        .innerJoin(
          userTotalFriendCount(ctx.db).as('userTotalFriendCount'),
          'userTotalFriendCount.userId',
          'friends.id'
        )
        .where('friendships.userId', '=', ctx.session.userId)
        .where('friendships.friendUserId', '=', input.friendUserId)
        .where('friendships.status', '=', FriendshipStatusSchema.Values['accepted'])
        .select([
          'friends.id',
          'friends.fullName',
          'friends.phoneNumber',
          'totalFriendCount',
        ])
        .executeTakeFirstOrThrow(() => new TRPCError({ code: 'NOT_FOUND' }));

      // Kết hợp kết quả
      const combinedResult = {
        ...friendInfo,
        mutualFriendCount: mutualFriendCountResult.mutualFriendCount,
      };

      // Xác thực và parse kết quả
      return friendInfoSchema.parse(combinedResult);
    }),
});


const userTotalFriendCount = (db: Database) => {
  return db
    .selectFrom('friendships')
    .where('friendships.status', '=', FriendshipStatusSchema.Values['accepted'])
    .select((eb) => [
      'friendships.userId',
      eb.fn.count('friendships.friendUserId').as('totalFriendCount'),
    ])
    .groupBy('friendships.userId')
}
