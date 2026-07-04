"use client";

import { useState } from "react";
import Hero from "@/components/Hero";
import BuilderInterface from "@/components/BuilderInterface";

export default function Home() {
  const [showBuilder, setShowBuilder] = useState(false);

  return (
    <main className="min-h-screen">
      {!showBuilder ? (
        <Hero onGetStarted={() => setShowBuilder(true)} />
      ) : (
        <BuilderInterface onBack={() => setShowBuilder(false)} />
      )}
    </main>
  );
}
