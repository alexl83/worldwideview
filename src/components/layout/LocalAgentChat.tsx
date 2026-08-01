"use client";

import { FormEvent, useState, useSyncExternalStore } from "react";
import { Bot, Send, X } from "lucide-react";
import { useSessionId } from "@/core/globe/hooks/useSessionId";
import styles from "./LocalAgentChat.module.css";

type Message = { role: "user" | "assistant"; text: string };

export function LocalAgentChat() {
    const sessionId = useSessionId();
    const [open, setOpen] = useState(false);
    const hidden = useSyncExternalStore(
        () => () => undefined,
        () => new URLSearchParams(window.location.search).get("headless") === "1",
        () => true,
    );
    const [prompt, setPrompt] = useState("");
    const [messages, setMessages] = useState<Message[]>([]);
    const [loading, setLoading] = useState(false);

    if (hidden) return null;

    async function submit(event: FormEvent) {
        event.preventDefault();
        const text = prompt.trim();
        if (!text || !sessionId || loading) return;
        setPrompt("");
        setMessages((current) => [...current, { role: "user", text }]);
        setLoading(true);
        try {
            const response = await fetch("/api/local-agent/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt: text, sessionId }),
            });
            const data = await response.json() as { text?: string; error?: string };
            setMessages((current) => [...current, {
                role: "assistant",
                text: response.ok ? (data.text || "Nessuna risposta.") : (data.error || "Agente non disponibile."),
            }]);
        } catch {
            setMessages((current) => [...current, { role: "assistant", text: "Agente locale non raggiungibile." }]);
        } finally {
            setLoading(false);
        }
    }

    if (!open) {
        return <button className={styles.launcher} onClick={() => setOpen(true)} title="Apri agente locale"><Bot /></button>;
    }

    return (
        <section className={styles.panel} aria-label="Agente locale WorldWideView">
            <header className={styles.header}>
                <span><Bot size={18} /> Agente locale</span>
                <button onClick={() => setOpen(false)} aria-label="Chiudi"><X size={18} /></button>
            </header>
            <div className={styles.session}>Scheda vincolata: {sessionId ? sessionId.slice(0, 8) : "connessione…"}</div>
            <div className={styles.messages}>
                {messages.length === 0 && <p className={styles.hint}>Interroga i dati o chiedimi di controllare questa mappa.</p>}
                {messages.map((message, index) => (
                    <div key={index} className={message.role === "user" ? styles.user : styles.assistant}>{message.text}</div>
                ))}
                {loading && <div className={styles.assistant}>Analisi in corso…</div>}
            </div>
            <form className={styles.form} onSubmit={submit}>
                <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Chiedi qualcosa sulla mappa…" rows={2} />
                <button type="submit" disabled={loading || !sessionId || !prompt.trim()} aria-label="Invia"><Send size={18} /></button>
            </form>
        </section>
    );
}
