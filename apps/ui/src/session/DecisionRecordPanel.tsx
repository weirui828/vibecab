export function DecisionRecordPanel({ items }: { items: unknown[] }) {
  return (
    <section aria-label="Decision record">
      <h2>Decision record</h2>
      {items.map((item, index) => (
        <p key={index}>{JSON.stringify(item)}</p>
      ))}
    </section>
  );
}
