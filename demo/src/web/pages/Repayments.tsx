import { z } from "zod";
import { loanView } from "../../domain/views.js";
import { ErrorNotice, date, label, money, useQuery } from "../hooks.js";
const loans = z.array(loanView);
export function Repayments({ epoch }: { epoch: number }) {
  const query = useQuery("/api/loans", loans, epoch);
  return (
    <section>
      <h1>내 대출·상환</h1>
      <p>실제 채무·송금이 없는 모의 일정입니다. 시간 이동만으로 미납이 되지 않습니다.</p>
      <ErrorNotice error={query.error} />
      {query.data?.length === 0 && <p>승인된 모의 대출이 없습니다.</p>}
      {query.data?.map((loan) => (
        <article key={loan.id}>
          <h2>모의 대출</h2>
          {loan.schedules.map((s) => (
            <p key={s.id}>
              {date(s.dueAt)} · {money(s.amountKrw)} · {label(s.status)} · 버전 {s.version}
            </p>
          ))}
          <a href="#support">상환 지원 요청</a>
        </article>
      ))}
    </section>
  );
}
