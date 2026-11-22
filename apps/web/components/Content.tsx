import type { ReactNode } from "react";

export interface Section {
  id: string;
  title: string;
  body: ReactNode;
}

export function ContentPage({ eyebrow, title, intro, sections, lead }: { eyebrow: string; title: string; intro: ReactNode; sections: Section[]; lead?: ReactNode }) {
  return (
    <div className="wrap page">
      <div className="page-head">
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="display">{title}</h1>
        <p>{intro}</p>
      </div>
      {lead}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 200px) minmax(0, 1fr)", gap: 40 }} className="content-grid">
        <nav className="toc hide-sm" aria-label="On this page">
          {sections.map((s) => (
            <a key={s.id} href={`#${s.id}`}>{s.title}</a>
          ))}
        </nav>
        <article className="prose">
          {sections.map((s) => (
            <section key={s.id} id={s.id}>
              <h2>{s.title}</h2>
              {s.body}
            </section>
          ))}
        </article>
      </div>
    </div>
  );
}
