"""Work milestones (ADR 0009): funded and reserved before work starts; a submission notice starts the
client's review clock; accepted and silently-passed units are paid; objections go to the resolver;
nothing submitted by due + grace is non-delivery.

Unit statuses: PLANNED (not yet reserved), RESERVED, CLAIMED (in the submission, under client review),
DISPUTED (objected, with the resolver), PAID, RELEASED_BY_TIMEOUT (paid by a deadline), REJECTED,
NOT_DELIVERED, RETURNED (reservation back to available). A milestone is final when every unit is.
"""
from .core import Refused, won

M_LIVE = {'FUNDED_AND_RESERVED', 'IN_PROGRESS', 'DELIVERED', 'DISPUTED', 'NON_DELIVERY'}
REASON_CODES = {'NOT_MET': '기준 미충족', 'MISSING': '누락', 'DEFECTIVE': '결함'}
U_PAID = {'PAID', 'RELEASED_BY_TIMEOUT'}
U_DONE = U_PAID | {'REJECTED', 'NOT_DELIVERED', 'RETURNED'}


class Milestones:
    def new_milestone(self, m, version):
        return {'id': m['id'], 'title': m['title'], 'version': version, 'status': 'PLANNED', 'amount': m['amount'],
                'start_by': m['startBy'], 'due_at': m['deliveryDueAt'],
                'grace_until': m['deliveryDueAt'] + m['deliveryGracePeriodSeconds'] * 1000,
                'units': [{'id': u['id'], 'title': u['title'], 'criteria': list(u['criteria']), 'amount': u['amount'],
                           'status': 'PLANNED', 'reason': None} for u in m['units']],
                'submission': None, 'review_deadline': None, 'resolver_deadline': None, 'objections': [],
                'paid': 0, 'returned': 0, 'started_at': None}

    def milestone(self, mid):
        m = self.milestones.get(mid)
        if m is None:
            raise Refused(f'마일스톤 {mid}이 없습니다', 'invalid')
        return m

    def reserve_planned(self):
        """Reserve every signed-but-unfunded milestone the available balance covers (not while paused)."""
        if self.status != 'ACTIVE' or self.paused:
            return ''
        done = []
        for m in self.milestones.values():
            if m['status'] == 'PLANNED' and m['amount'] <= min(self.available, self.milestone_capacity()):
                self.milestone_reserved += m['amount']
                m['status'] = 'FUNDED_AND_RESERVED'
                for u in m['units']:
                    u['status'] = 'RESERVED'
                done.append(f"{m['id']} {won(m['amount'])}")
        return f" — 마일스톤 예약: {', '.join(done)} (FUNDED_AND_RESERVED, 착수 가능)" if done else ''

    def pay_unit(self, u, status, reason):
        self.milestone_reserved -= u['amount']
        self.milestone_released += u['amount']
        u['status'], u['reason'] = status, reason
        return u['amount']

    def return_unit(self, u, status, reason):
        self.milestone_reserved -= u['amount']
        u['status'], u['reason'] = status, reason
        return u['amount']

    def settle_status(self, m):
        units = m['units']
        m['paid'] = sum(u['amount'] for u in units if u['status'] in U_PAID)
        m['returned'] = sum(u['amount'] for u in units if u['status'] in U_DONE - U_PAID)
        if all(u['status'] in U_DONE for u in units):
            if m['status'] not in ('EXPIRED_UNUSED', 'CANCELLED'):
                paid = [u for u in units if u['status'] in U_PAID]
                m['status'] = 'PAID' if len(paid) == len(units) else 'PARTIAL' if paid else 'REJECTED'
        elif any(u['status'] == 'CLAIMED' for u in units):
            m['status'] = 'DELIVERED'
        elif any(u['status'] == 'DISPUTED' for u in units):
            m['status'] = 'DISPUTED'

    # -- contractor
    def op_start_milestone(self, line, p, i):
        self.need(line, 'contractor')
        self.state_is('ACTIVE', 'CLOSING')
        m = self.milestone(p.get('milestone'))
        if m['status'] != 'FUNDED_AND_RESERVED':
            raise Refused('예약이 끝난 마일스톤만 착수할 수 있습니다')
        if line['at'] > m['start_by']:
            raise Refused('착수 기한이 지났습니다', 'deadline')
        m['status'], m['started_at'] = 'IN_PROGRESS', line['at']
        return f"작업자가 {m['id']} {m['title']} 작업을 시작했습니다 (작업비 {won(m['amount'])} 예약 확인)"

    def op_cancel_milestone(self, line, p, i):
        self.need(line, 'contractor')
        m = self.milestone(p.get('milestone'))
        if m['status'] not in ('PLANNED', 'FUNDED_AND_RESERVED'):
            raise Refused('착수 전 마일스톤만 취소할 수 있습니다')
        back = sum(self.return_unit(u, 'RETURNED', 'cancelled') for u in m['units'] if u['status'] == 'RESERVED')
        for u in m['units']:
            if u['status'] == 'PLANNED':
                u['status'] = 'RETURNED'
        m['status'] = 'CANCELLED'
        self.settle_status(m)
        return f"작업자가 착수 전 {m['id']}을(를) 취소했습니다 (예약 {won(back)} 가용 복귀)"

    def op_submit_delivery(self, line, p, i):
        self.need(line, 'contractor')
        m = self.milestone(p.get('milestone'))
        if m['status'] != 'IN_PROGRESS':
            raise Refused('진행 중인 마일스톤만 제출할 수 있습니다 (제출은 한 번)')
        if line['at'] > m['grace_until']:
            raise Refused('납기와 유예기간이 지났습니다', 'deadline')
        ids = p.get('units') or []
        units = {u['id']: u for u in m['units']}
        if not ids or any(x not in units or units[x]['status'] != 'RESERVED' for x in ids) or len(set(ids)) != len(ids):
            raise Refused('제출할 납품 단위를 하나 이상 고르세요', 'invalid')
        for x in ids:
            units[x]['status'] = 'CLAIMED'
        m['submission'] = {'at': line['at'], 'units': list(ids), 'note': str(p.get('note') or '')[:2000],
                           'documents': list(i.get('documents') or [])}
        m['review_deadline'] = line['at'] + self.period('clientReviewPeriodSeconds', m['version'])
        m['status'] = 'DELIVERED'
        claimed = sum(units[x]['amount'] for x in ids)
        return (f"작업자가 {m['id']} 제출 통지를 보냈습니다 (납품 단위 {len(ids)}개, {won(claimed)}) — "
                f"클라이언트 검수 기한 시작")

    # -- client
    def op_review_delivery(self, line, p, i):
        self.need(line, 'client')
        m = self.milestone(p.get('milestone'))
        if not any(u['status'] == 'CLAIMED' for u in m['units']):
            raise Refused('검수할 제출 단위가 없습니다')
        if line['at'] > m['review_deadline']:
            raise Refused('검수 기한이 지났습니다', 'deadline')
        units = {u['id']: u for u in m['units']}
        accept, objections = p.get('accept') or [], p.get('object') or []
        named = list(accept) + [o.get('unit') for o in objections]
        if not named or len(set(named)) != len(named) or any(x not in units or units[x]['status'] != 'CLAIMED' for x in named):
            raise Refused('제출된 납품 단위마다 승인 또는 이의를 한 번씩만 고르세요', 'invalid')
        for o in objections:
            u = units[o['unit']]
            if o.get('criterion') not in u['criteria']:
                raise Refused(f"{u['title']}: 이의는 사전에 합의된 인수 기준 중에서만 고를 수 있습니다", 'invalid')
            if o.get('reason_code') not in REASON_CODES:
                raise Refused(f"이유 코드는 {', '.join(REASON_CODES)} 중 하나입니다", 'invalid')
            if not str(o.get('reason') or '').strip():
                raise Refused('이의 사유를 적어 주세요', 'invalid')
        paid = sum(self.pay_unit(units[x], 'PAID', 'accepted') for x in accept)
        for o in objections:
            units[o['unit']]['status'] = 'DISPUTED'
            m['objections'].append({'unit': o['unit'], 'criterion': o['criterion'], 'reason_code': o['reason_code'],
                                    'reason': str(o['reason'])[:1000], 'at': line['at']})
        if objections and not m['resolver_deadline']:
            m['resolver_deadline'] = line['at'] + self.period('resolverReviewPeriodSeconds', m['version'])
        self.settle_status(m)
        text = f"클라이언트가 {m['id']}을(를) 검수했습니다: 승인 {len(accept)}건 {won(paid)} 지급"
        return text + (f", 이의 {len(objections)}건 → 분쟁 해결" if objections else '')

    # -- resolver
    def op_resolve_milestone(self, line, p, i):
        self.need(line, 'resolver')
        m = self.milestone(p.get('milestone'))
        if m['status'] not in ('DISPUTED', 'NON_DELIVERY'):
            raise Refused('분쟁 해결 대상 단위가 없습니다')
        if line['at'] > m['resolver_deadline']:
            raise Refused('분쟁 해결 기한이 지났습니다', 'deadline')
        units = {u['id']: u for u in m['units']}
        open_ = 'RESERVED' if m['status'] == 'NON_DELIVERY' else 'DISPUTED'
        decisions = p.get('decisions') or []
        if not decisions or any(d.get('unit') not in units or units[d['unit']]['status'] != open_ for d in decisions):
            raise Refused('분쟁 해결 대상 단위만 결정할 수 있습니다', 'invalid')
        paid = back = 0
        for d in decisions:
            u, reason = units[d['unit']], str(d.get('reason') or '').strip()
            if not reason:
                raise Refused('결정 사유를 적어 주세요', 'invalid')
            if d.get('accept') and open_ == 'RESERVED':
                raise Refused('제출되지 않은 단위는 지급할 수 없습니다 (미납)', 'invalid')
            if d.get('accept'):
                paid += self.pay_unit(u, 'PAID', f'resolver: {reason}')
            else:
                back += self.return_unit(u, 'REJECTED', f'resolver: {reason}')
        self.settle_status(m)
        return f"분쟁 해결자가 {m['id']}을(를) 결정했습니다: 지급 {won(paid)}, 거절 {won(back)}"

    # -- deadlines
    def milestone_clocks(self):
        """[(deadline, kind, milestone id)] for every running milestone clock."""
        out = []
        for m in self.milestones.values():
            s = m['status']
            if s == 'FUNDED_AND_RESERVED':
                out.append((m['start_by'], 'start', m['id']))
            if s == 'IN_PROGRESS':
                out.append((m['grace_until'], 'delivery', m['id']))
            if m['submission'] and any(u['status'] == 'RESERVED' for u in m['units']):
                out.append((m['grace_until'], 'unclaimed', m['id']))
            if any(u['status'] == 'CLAIMED' for u in m['units']):
                out.append((m['review_deadline'], 'client_review', m['id']))
            if s == 'NON_DELIVERY' or any(u['status'] == 'DISPUTED' for u in m['units']):
                out.append((m['resolver_deadline'], 'resolver_review', m['id']))
        return out

    def milestone_timeout(self, kind, m):
        if kind == 'start':
            back = sum(self.return_unit(u, 'RETURNED', 'start_by passed') for u in m['units'] if u['status'] == 'RESERVED')
            m['status'] = 'EXPIRED_UNUSED'
            self.settle_status(m)
            return f"{m['id']} 착수 기한 경과 — 미사용 예약 {won(back)} 복귀 (EXPIRED_UNUSED)"
        if kind == 'delivery':
            m['status'] = 'NON_DELIVERY'
            m['resolver_deadline'] = self.at + self.period('resolverReviewPeriodSeconds', m['version'])
            return f"{m['id']} 납기+유예 경과, 제출 없음 — 미납 검토 (분쟁 해결)"
        if kind == 'unclaimed':
            back = sum(self.return_unit(u, 'NOT_DELIVERED', 'not in the submission') for u in m['units']
                       if u['status'] == 'RESERVED')
            self.settle_status(m)
            return f"{m['id']} 제출 통지에 없던 단위 미납 처리 — {won(back)} 가용 복귀"
        if kind == 'client_review':
            paid = sum(self.pay_unit(u, 'RELEASED_BY_TIMEOUT', 'client silent') for u in m['units'] if u['status'] == 'CLAIMED')
            self.settle_status(m)
            return f"{m['id']} 클라이언트 검수 기한 경과 — 제출 단위 {won(paid)} 자동 지급 (RELEASED_BY_TIMEOUT)"
        if kind == 'resolver_review':
            if m['status'] == 'NON_DELIVERY':
                back = sum(self.return_unit(u, 'REJECTED', 'non-delivery, resolver silent') for u in m['units']
                           if u['status'] == 'RESERVED')
                self.settle_status(m)
                return f"{m['id']} 미납 분쟁 해결 기한 경과 — 거절, {won(back)} 복귀 (REJECTED_BY_TIMEOUT)"
            paid = sum(self.pay_unit(u, 'RELEASED_BY_TIMEOUT', 'resolver silent, claim complete')
                       for u in m['units'] if u['status'] == 'DISPUTED')
            self.settle_status(m)
            return f"{m['id']} 분쟁 해결 기한 경과 — 이의 단위 {won(paid)} 지급 (제출 완전, 결함 증명 없음)"
        raise Refused(f'알 수 없는 기한 {kind}', 'invalid')

