import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { buildTimelineEntry } from '@/utils/review'
import { CORRECTION, correctionTypeLabel, canCreateCorrection, isCorrectionOpen, canClaimCorrection } from '@/utils/correction'
import { GUEST_ID } from '@/utils/permission'

// 知识纠错处置闭环 store：
// 成员发现文档错误并关联文档提交（open）→ 编辑者认领修订（claimed）→
// 修订内容送审（in_review，送审由 review store 的 submitCorrectionReview 在一个事务内完成：
// 建评审单 + 锁文档 + 工单关联）→ 管理员审批通过（resolved，回写版本、问答引用恢复）/
// 驳回退回修订（claimed）。提交人全程可在「我提交的」里追踪状态与 timeline；
// 异常退出：提交人待认领阶段撤单（revoked）、编辑者认领后退回（revoked）、
// 送审撤回（回 claimed）、关联文档被删除（自动关闭，revoked）。
// 审批联动（syncCorrectionTicket）由 review store 在决策/撤回的同一事务内调用，两边状态不会脱节。
export const useCorrectionStore = defineStore('correction', () => {
  const tickets = ref([])
  const loaded = ref(false)

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
    // 首次加载自愈「卡在送审中」的历史工单（关联评审单已完结/丢失但工单未联动）
    await reconcileStuckTickets()
  }

  async function reload() {
    tickets.value = await db.correctionTickets.toArray()
  }

  // 待认领数量（侧边栏角标，编辑者/管理员视角的工作量）
  const openCount = computed(() => tickets.value.filter((t) => t.status === CORRECTION.OPEN).length)
  // 待管理员审批数量（纠错修订送审中）
  const pendingReviewCount = computed(() => tickets.value.filter((t) => t.status === CORRECTION.IN_REVIEW).length)

  // [docId] -> 流转中的纠错单（一篇文档同时只允许一个流转中纠错单）
  const activeTicketMap = computed(() => {
    const m = {}
    for (const t of tickets.value) if (isCorrectionOpen(t)) m[t.docId] = t
    return m
  })

  function activeTicketOfDoc(docId) {
    return activeTicketMap.value[docId] || null
  }

  function ticketsOfDoc(docId) {
    return tickets.value
      .filter((t) => t.docId === docId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }

  // 我提交的纠错单（提交人追踪状态）
  function ticketsSubmittedBy(userId) {
    return tickets.value
      .filter((t) => t.submittedBy === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }

  // 同一文档上是否已有流转中纠错单（提交去重：同一篇文档不重复挂单）
  function activeTicketForDoc(docId) {
    return tickets.value.find((t) => isCorrectionOpen(t) && t.docId === docId) || null
  }

  // 成员提交纠错。必须关联文档；同一文档已有流转中纠错单时直接返回已有单，避免重复。
  // 访客不可提交：纠错单会进入认领/送审流程，必须有明确责任人供状态追踪
  async function createTicket({ docId, type, summary, detail, expected }, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (!canCreateCorrection(currentUser)) return { status: 'guest' }
    if (!docId) return { status: 'no-doc' }
    const dup = activeTicketForDoc(docId)
    if (dup) return { status: 'duplicate', ticket: dup }
    const now = new Date().toISOString()
    const ticket = {
      id: uid('cor'),
      docId,
      type: type || 'other',
      summary: String(summary || '').trim(),
      detail: String(detail || '').trim(),
      expected: String(expected || '').trim(),
      status: CORRECTION.OPEN,
      submittedBy: userId,
      createdAt: now,
      claimedBy: null,
      claimedAt: null,
      reviewId: null,
      submittedAt: null,
      resolvedAt: null,
      resolvedVersion: null,
      decidedBy: null,
      decidedAt: null,
      closeNote: '',
      timeline: [buildTimelineEntry('create', userId, '关联文档提交纠错（' + correctionTypeLabel(type || 'other') + '）', now)]
    }
    await db.correctionTickets.add(ticket)
    await reload()
    return { status: 'ok', ticket }
  }

  // 编辑者认领：open → claimed。事务内复核角色与状态
  async function claimTicket(id, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    let result = { status: 'error' }
    if (userId === GUEST_ID) return { status: 'denied' }
    await db.transaction('rw', db.correctionTickets, async () => {
      const t = await db.correctionTickets.get(id)
      if (!t) { result = { status: 'missing' }; return }
      if (t.status !== CORRECTION.OPEN) { result = { status: 'changed', ticket: t }; return }
      if (!canClaimCorrection(currentUser?.role, t)) { result = { status: 'denied' }; return }
      await db.correctionTickets.update(id, {
        status: CORRECTION.CLAIMED,
        claimedBy: userId,
        claimedAt: now,
        timeline: [...(t.timeline || []), buildTimelineEntry('claim', userId, '', now)]
      })
      result = { status: 'ok' }
    })
    await reload()
    return result
  }

  function canClaimLocal(role) {
    return role === 'admin' || role === 'editor'
  }

  // 取消认领：claimed → open
  async function releaseTicket(id, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    let result = { status: 'error' }
    if (userId === GUEST_ID) return { status: 'denied' }
    await db.transaction('rw', db.correctionTickets, async () => {
      const t = await db.correctionTickets.get(id)
      if (!t) { result = { status: 'missing' }; return }
      if (t.status !== CORRECTION.CLAIMED) { result = { status: 'changed', ticket: t }; return }
      if (t.claimedBy !== userId && currentUser?.role !== 'admin') { result = { status: 'denied' }; return }
      await db.correctionTickets.update(id, {
        status: CORRECTION.OPEN,
        claimedBy: null,
        claimedAt: null,
        timeline: [...(t.timeline || []), buildTimelineEntry('release', userId, '', now)]
      })
      result = { status: 'ok' }
    })
    await reload()
    return result
  }

  // 提交人撤单（待认领阶段）：open → revoked。认领后不可自行撤回，需联系处理编辑者
  async function revokeBySubmitter(id, note, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    let result = { status: 'error' }
    if (userId === GUEST_ID) return { status: 'denied' }
    await db.transaction('rw', db.correctionTickets, async () => {
      const t = await db.correctionTickets.get(id)
      if (!t) { result = { status: 'missing' }; return }
      if (t.status !== CORRECTION.OPEN || t.submittedBy !== userId) { result = { status: 'denied', ticket: t }; return }
      await db.correctionTickets.update(id, {
        status: CORRECTION.REVOKED,
        decidedBy: userId,
        decidedAt: now,
        closeNote: note || '',
        timeline: [...(t.timeline || []), buildTimelineEntry('revoke', userId, note, now)]
      })
      result = { status: 'ok' }
    })
    await reload()
    return result
  }

  // 编辑者退回（认领后认为问题不成立/无需修订）：claimed → revoked，需说明并对提交人可见
  async function dismissByEditor(id, note, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    let result = { status: 'error' }
    if (userId === GUEST_ID) return { status: 'denied' }
    await db.transaction('rw', db.correctionTickets, async () => {
      const t = await db.correctionTickets.get(id)
      if (!t) { result = { status: 'missing' }; return }
      if (t.status !== CORRECTION.CLAIMED) { result = { status: 'changed', ticket: t }; return }
      if (t.claimedBy !== userId && currentUser?.role !== 'admin') { result = { status: 'denied' }; return }
      await db.correctionTickets.update(id, {
        status: CORRECTION.REVOKED,
        decidedBy: userId,
        decidedAt: now,
        closeNote: note || '',
        timeline: [...(t.timeline || []), buildTimelineEntry('dismiss', userId, note, now)]
      })
      result = { status: 'ok' }
    })
    await reload()
    return result
  }

  // 审批/撤回事务内联动（由 review store 在同事务调用，tables 需含 db.correctionTickets）：
  // approve：纠错单置为已修正，记录回写版本号（问答引用随文档更新自动恢复）；
  // reject/withdraw：退回修订中，仅解除评审单关联，保留文档关联便于修改后重新送审
  async function syncCorrectionTicket(reviewId, action, note, userId, now, resolvedVersion) {
    const linked = await db.correctionTickets.where('reviewId').equals(reviewId).toArray()
    const tickets = linked.filter((t) => t.status === CORRECTION.IN_REVIEW)
    for (const ticket of tickets) {
      if (action === 'resolve') {
        await db.correctionTickets.update(ticket.id, {
          status: CORRECTION.RESOLVED,
          resolvedAt: now,
          resolvedVersion: resolvedVersion || null,
          decidedBy: userId,
          decidedAt: now,
          closeNote: note || '',
          timeline: [...(ticket.timeline || []), buildTimelineEntry('resolve', userId, '审批通过，修订回写为 v' + (resolvedVersion || '?'), now)]
        })
      } else {
        const reason = action === 'return'
          ? '评审驳回' + (note ? '：' + note : '') + '，退回修订'
          : '评审已撤回，继续修订'
        await db.correctionTickets.update(ticket.id, {
          status: CORRECTION.CLAIMED,
          reviewId: null,
          timeline: [...(ticket.timeline || []), buildTimelineEntry(action === 'return' ? 'return' : 'withdraw', userId, reason, now)]
        })
      }
    }
  }

  // 自愈「卡在送审中」的工单：关联评审单已完结/丢失时按结论补齐状态——
  // 已通过 → 已修正；已驳回/已撤回/评审单丢失 → 退回修订中并解除失效关联。
  // 与缺口工单同一历史成因（两步式送审），现为单事务送审不再新增，此处仅修复存量。
  async function reconcileStuckTickets() {
    const { REVIEW } = await import('@/utils/review')
    const stuck = tickets.value.filter((t) => t.status === CORRECTION.IN_REVIEW)
    if (!stuck.length) return
    const now = new Date().toISOString()
    let changed = false
    await db.transaction('rw', db.correctionTickets, db.reviews, async () => {
      for (const t of stuck) {
        const review = t.reviewId ? await db.reviews.get(t.reviewId) : null
        if (review && review.status === REVIEW.PENDING) continue
        const fresh = await db.correctionTickets.get(t.id)
        if (!fresh || fresh.status !== CORRECTION.IN_REVIEW) continue
        if (review && review.status === REVIEW.APPROVED) {
          await db.correctionTickets.update(t.id, {
            status: CORRECTION.RESOLVED,
            resolvedAt: review.decidedAt || now,
            decidedBy: review.decidedBy || 'system',
            decidedAt: review.decidedAt || now,
            timeline: [...(fresh.timeline || []), buildTimelineEntry('resolve', review.decidedBy || 'system', '审批通过，修订已发布', now)]
          })
        } else {
          const reason = !review
            ? '关联评审单已丢失，退回修订'
            : review.status === REVIEW.REJECTED
              ? '评审驳回' + (review.decisionNote ? '：' + review.decisionNote : '') + '，退回修订'
              : '评审已撤回，继续修订'
          await db.correctionTickets.update(t.id, {
            status: CORRECTION.CLAIMED,
            reviewId: null,
            timeline: [...(fresh.timeline || []), buildTimelineEntry(review && review.status === REVIEW.REJECTED ? 'return' : 'withdraw', (review && review.decidedBy) || 'system', reason, now)]
          })
        }
        changed = true
      }
    })
    if (changed) await reload()
  }

  // 关联文档被删除时关闭流转中纠错单（终态 revoked，记录保留并向提交人说明）
  async function closeTicketsOfDeletedDoc(docId) {
    await loadAll()
    const now = new Date().toISOString()
    const list = tickets.value.filter((t) => t.docId === docId && isCorrectionOpen(t))
    if (!list.length) return
    await db.transaction('rw', db.correctionTickets, async () => {
      for (const t of list) {
        await db.correctionTickets.update(t.id, {
          status: CORRECTION.REVOKED,
          reviewId: null,
          decidedBy: 'system',
          decidedAt: now,
          closeNote: '关联文档已删除，纠错单自动关闭',
          timeline: [...(t.timeline || []), buildTimelineEntry('reset', 'system', '关联文档已删除，纠错单自动关闭', now)]
        })
      }
    })
    await reload()
  }

  return {
    tickets, loaded, loadAll, reload,
    openCount, pendingReviewCount,
    activeTicketMap, activeTicketOfDoc, ticketsOfDoc, ticketsSubmittedBy,
    activeTicketForDoc, createTicket, claimTicket, releaseTicket,
    revokeBySubmitter, dismissByEditor, syncCorrectionTicket,
    reconcileStuckTickets, closeTicketsOfDeletedDoc
  }
})
