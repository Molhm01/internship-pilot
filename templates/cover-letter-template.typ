#let coverLetter(name: "", location: "", contact: (), date: "", company: "", jobTitle: "", paragraphs: ()) = {
  set page(paper: "us-letter", margin: (x: 0.78in, y: 0.72in))
  set text(font: "Arial", size: 11pt, fill: rgb("20242a"))
  set par(justify: false, leading: 0.72em)

  text(size: 18pt, weight: "bold")[#name]
  v(2pt)
  text(size: 9.5pt)[#((location,) + contact).filter(x => x != "").join("  |  ")]
  v(16pt)
  date
  v(14pt)
  [Dear #company Hiring Team,]
  v(9pt)
  for p in paragraphs {
    par(p)
    v(9pt)
  }
  [Thank you for your time and consideration.]
  v(12pt)
  [Sincerely,]
  v(4pt)
  strong(name)
}
