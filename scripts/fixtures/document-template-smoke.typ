#import "/templates/resume-template.typ": resume
#resume(
  name: "Test Candidate", location: "Clifton, NJ", contact: ("555-0100", "test@example.com"),
  education: ((school: "New Jersey Institute of Technology", degree: "B.S. in Electrical Engineering", dates: "Expected May 2029", location: "Newark, NJ", note: ""),),
  skillGroups: ((label: "Programming", items: ("C++", "Python")), (label: "Hardware and Electronics", items: ("Arduino", "Circuit prototyping"))),
  coursework: ("Circuits & Systems I", "Digital Design"),
  experience: ((title: "PC Builder and Repair Technician", subtitle: "Freelance", dates: "2021–Present", meta: "Clifton, NJ", bullets: ("Built 30+ custom PCs", "Completed 100+ hardware repairs")),),
  projects: ((title: "Air Quality Monitor", subtitle: "", dates: "", meta: "Technologies: Arduino, OLED", bullets: ("Sampled MQ-135 sensor data", "Implemented threshold-based alerts")),),
  activities: ("IEEE — Member",),
)
