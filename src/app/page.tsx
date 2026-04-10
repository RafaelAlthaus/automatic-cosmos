import Link from "next/link";

const tools = [
  {
    href: "/storyblocks",
    title: "Storyblocks Video Scraper",
    description: "Scrape and batch-download videos from Storyblocks search results using your account cookies.",
    badge: "Downloader",
  },
  {
    href: "/srt-images",
    title: "SRT to Images",
    description: "Upload an SRT file, generate AI image descriptions per caption segment, and create matching images.",
    badge: "AI Generator",
  },
  {
    href: "/txt-to-srt",
    title: "TXT to SRT",
    description: "Convert a plain text script into a timed SRT subtitle file ready for video production.",
    badge: "Converter",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-xl font-semibold">Content Creator Assistant</h1>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-16">
		<br /> <br />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {tools.map((tool) => (
            <Link
              key={tool.href}
              href={tool.href}
              className="group flex flex-col gap-3 bg-zinc-900 border border-zinc-800 hover:border-zinc-600 rounded-xl p-6 transition"
            >
              <span className="text-xs font-mono text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded w-fit">
                {tool.badge}
              </span>
              <h2 className="text-base font-semibold group-hover:text-white transition">{tool.title}</h2>
              <p className="text-sm text-zinc-400 leading-relaxed">{tool.description}</p>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
