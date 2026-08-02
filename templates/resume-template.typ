// Fixed recreation of templates/master_resume_reference.pdf.
#let resume(name: "", contact: (), education: (), experience: (), projects: (), skills: (), activities: ()) = {
  set page(paper: "us-letter", margin: (left: 0.444in, right: 0.43in, y: 0.34in))
  set text(font: "IBM Plex Sans", size: 10pt, tracking: -0.0085em, hyphenate: false, fill: black)
  set par(justify: false, leading: 0.62em)
  let section(title, body) = {
    block(above: 6pt, below: 2pt, breakable: false)[
      #text(font: "Times New Roman", size: 9pt, weight: "bold", style: "italic", tracking: 0pt)[#title]
      #v(-0.5pt)
      #line(length: 100%, stroke: 0.55pt)
    ]
    body
  }
  let bullet(value, project: false) = block(above: 0.5pt, below: if project { 5.8pt } else { 5.7pt }, inset: (left: 6pt))[
    #set par(leading: if project { 0.58em } else { 0.43em })
    #grid(columns: (6pt, 1fr), column-gutter: 3pt, [•], [#value])
  ]
  let entry(item, project: false, first: false) = block(above: if project and first { 6pt } else if project { 4pt } else if first { 0pt } else if item.organization == "" { 7.2pt } else { 2.9pt }, below: if project { 4pt } else { 2.3pt }, inset: (left: 10pt), breakable: false)[
    #if project {
      grid(columns: (1fr, auto), column-gutter: 8pt,
        [#text(font: "Times New Roman", weight: "bold", style: "italic", tracking: 0pt)[#item.title#if item.organization != "" [ #item.organization]]], [#item.dates])
    } else if item.organization == "" {
      grid(columns: (1fr, auto), rows: (auto, auto), row-gutter: 4.2pt, column-gutter: 8pt,
        [#text(font: "Times New Roman", weight: "bold", style: "italic", tracking: 0pt)[#item.title]], [#item.dates],
        [#for value in item.bullets { bullet(value) }],
        [#if item.location != "" [#text(font: "Times New Roman", weight: "bold", style: "italic", tracking: 0pt)[#item.location]]])
    } else {
      grid(columns: (1fr, auto), rows: (auto, auto), row-gutter: 4.2pt, column-gutter: 8pt,
        [#text(font: "Times New Roman", weight: "bold", style: "italic", tracking: 0pt)[#item.title]], [#item.dates],
        [#if item.organization != "" [#text(font: "Times New Roman", weight: "bold", style: "italic", tracking: 0pt)[#item.organization]]],
        [#if item.location != "" [#text(font: "Times New Roman", weight: "bold", style: "italic", tracking: 0pt)[#item.location]]])
    }
    #if item.organization != "" or project {
      v(if project { 6.5pt } else { 5.5pt })
      for value in item.bullets { bullet(value, project: project) }
    }
  ]
  align(center)[
    #stack(dir: ttb, spacing: 10.6pt,
      move(dx: -2pt, text(font: "Times New Roman", size: 16pt, weight: "bold", style: "italic", tracking: 0pt)[#name]),
      move(dx: -3.3pt, text(size: 9pt, tracking: 0pt)[#contact.join(" | ")]))
  ]
  v(13.3pt)
  section("EDUCATION", {
    for item in education {
      block(above: 0.8pt, below: 4.8pt, inset: (left: 10pt), breakable: false)[
        #grid(columns: (1fr, auto), rows: (auto, auto), row-gutter: 4.2pt, column-gutter: 8pt,
          [#text(font: "Times New Roman", weight: "bold", style: "italic", tracking: 0pt)[#item.school]], [#item.location],
          [#text(font: "Times New Roman", weight: "bold", style: "italic", tracking: 0pt)[#item.degree]],
          [#text(font: "Times New Roman", weight: "bold", style: "italic", tracking: 0pt)[#item.dates]])
        #v(-6.3pt)
        #item.coursework
      ]
    }
    v(4pt)
  })
  section("EXPERIENCE", { for (index, item) in experience.enumerate() { entry(item, first: index == 0) }; v(8.1pt) })
  section("PROJECTS", { for (index, item) in projects.enumerate() { entry(item, project: true, first: index == 0) }; v(2.6pt) })
  section("SKILLS", {
    for group in skills {
      block(above: if group.label == "Languages" { 0pt } else { 6.55pt }, below: 6.55pt, inset: (left: 11pt))[
        #text(font: "Times New Roman", weight: "bold", style: "italic", tracking: 0pt)[#group.label:]
        #if group.label == "Additional" {
          linebreak()
          [#group.items.slice(0, 4).join(", ")]
          linebreak()
          [#group.items.slice(4).join(", ")]
        } else {
          [ #group.items.join(", ")]
        }
      ]
    }
    v(7.2pt)
  })
  section("ACTIVITIES & LEADERSHIP", {
    v(-1.9pt)
    for (index, item) in activities.enumerate() {
      let parts = item.split("  -  ")
      block(above: if index == 0 { 0pt } else { 4.6pt }, below: 3pt, inset: (left: 8.5pt))[
        #text(font: "Times New Roman", weight: "bold", style: "italic", tracking: 0pt)[#parts.at(0) #h(9pt)-#h(9pt) #parts.at(1)]
      ]
    }
  })
}
